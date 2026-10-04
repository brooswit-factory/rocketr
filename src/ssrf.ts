/**
 * SSRF guard: the client supplies the Rocket.Chat URL, so rocketr is an open relay unless every
 * outbound connection resolves and connects itself, checks every resolved address against a
 * compiled-in deny list, and pins the socket to the checked address (defeats DNS rebinding between
 * the check and the connect). https only; no redirects; response size caps and timeouts.
 */
import { request as httpsRequest } from "node:https";
import { resolve4 as dnsResolve4, resolve6 as dnsResolve6 } from "node:dns/promises";

export class SsrfBlockedError extends Error {}

export interface Resolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export const systemResolver: Resolver = { resolve4: dnsResolve4, resolve6: dnsResolve6 };

/** `base/bits` IPv4 CIDR membership. `ip` is a 32-bit unsigned int. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inV4Cidr(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

/** Expands a textual IPv6 address (including `::` compression and a trailing embedded IPv4) to a 128-bit BigInt. */
function ipv6ToBigInt(ip: string): bigint | null {
  const zoneless = ip.split("%")[0]!;
  const parts = zoneless.split("::");
  if (parts.length > 2) return null;
  const expandSide = (side: string) => (side === "" ? [] : side.split(":"));
  let head = expandSide(parts[0]!);
  let tail = parts.length === 2 ? expandSide(parts[1]!) : [];

  // An embedded IPv4 tail (e.g. "::ffff:1.2.3.4") becomes two hextets.
  const last = tail.length ? tail[tail.length - 1]! : head.length ? head[head.length - 1]! : undefined;
  if (last?.includes(".")) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16), lo = (v4 & 0xffff).toString(16);
    const arr = tail.length ? tail : head;
    arr[arr.length - 1] = hi;
    arr.push(lo);
  }

  const total = head.length + tail.length;
  if (parts.length === 1) {
    if (head.length !== 8) return null;
  } else {
    if (total > 8) return null;
    const zeros = Array(8 - total).fill("0");
    head = [...head, ...zeros];
  }
  const groups = [...head, ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function inV6Cidr(ip: bigint, base: string, bits: number): boolean {
  const b = ipv6ToBigInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0n : (((1n << 128n) - 1n) << BigInt(128 - bits)) & ((1n << 128n) - 1n);
  return (ip & mask) === (b & mask);
}

const V4_DENY: Array<[string, number]> = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, incl. 169.254.169.254 (cloud metadata)
  ["172.16.0.0", 12],    // RFC1918
  ["192.168.0.0", 16],   // RFC1918
  ["224.0.0.0", 4],      // multicast
  ["255.255.255.255", 32], // broadcast
];

const V6_DENY: Array<[string, number]> = [
  ["::", 128],      // unspecified
  ["::1", 128],     // loopback
  ["fc00::", 7],    // unique local (ULA)
  ["fe80::", 10],   // link-local
  ["ff00::", 8],    // multicast
];

/** Whether `ip` (v4 or v6) falls in the `base/bits` CIDR range. Used by the deny list and, separately, by the bind guard's allow-ranges. Address families must match — an IPv4 address is never "in" an IPv6 range or vice versa. */
export function matchesCidr(ip: string, base: string, bits: number): boolean {
  const ip4 = ipv4ToInt(ip), base4 = ipv4ToInt(base);
  if (ip4 !== null && base4 !== null) return inV4Cidr(ip4, base, bits);
  if (ip4 !== null || base4 !== null) return false; // one parsed as v4, the other didn't — family mismatch
  const ip6 = ipv6ToBigInt(ip), base6 = ipv6ToBigInt(base);
  if (ip6 !== null && base6 !== null) return inV6Cidr(ip6, base, bits);
  return false;
}

/** True if `ip` (v4 or v6, including an IPv4-mapped IPv6 form) falls in the compiled-in deny list. */
export function isDeniedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return V4_DENY.some(([base, bits]) => inV4Cidr(v4, base, bits));
  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) return true; // unparsable — refuse rather than let a malformed record through
  if (V6_DENY.some(([base, bits]) => inV6Cidr(v6, base, bits))) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d): check the embedded v4 address too.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip.split("%")[0]!);
  if (mapped) { const inner = ipv4ToInt(mapped[1]!); if (inner !== null) return V4_DENY.some(([base, bits]) => inV4Cidr(inner, base, bits)); }
  return false;
}

/** Every A/AAAA record for `hostname`. Throws if DNS returns no usable records at all. */
export async function resolveAllAddresses(hostname: string, resolver: Resolver = systemResolver): Promise<string[]> {
  const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const addrs: string[] = [];
  for (const r of results) if (r.status === "fulfilled") addrs.push(...r.value);
  if (!addrs.length) throw new SsrfBlockedError(`DNS resolution for "${hostname}" returned no A/AAAA records`);
  return addrs;
}

/**
 * Resolves `hostname`, checks EVERY returned address against the deny list (refusing if any one
 * is denied — a multi-answer record could otherwise let a client pick the benign answer now and a
 * private one on a later lookup), and returns one checked address to pin the connection to.
 */
export async function checkedAddress(hostname: string, resolver: Resolver = systemResolver): Promise<string> {
  const addrs = await resolveAllAddresses(hostname, resolver);
  for (const addr of addrs) if (isDeniedAddress(addr)) throw new SsrfBlockedError(`"${hostname}" resolves to ${addr}, which is in the compiled-in deny list`);
  return addrs[0]!;
}

export interface FetchLimits { timeoutMs: number; maxBytes: number }
export const DEFAULT_FETCH_LIMITS: FetchLimits = { timeoutMs: 15_000, maxBytes: 25 * 1024 * 1024 };

/** A tiny multipart/form-data encoder — just enough for the one-field file upload rocketr sends. */
export async function encodeFormData(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const boundary = `----rocketr-${crypto.randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of form as unknown as Iterable<[string, string | Blob]>) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (value instanceof Blob) {
      const filename = (value as Blob & { name?: string }).name ?? "file";
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`));
      parts.push(Buffer.from(`Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`));
      parts.push(Buffer.from(await value.arrayBuffer()));
    } else {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
      parts.push(Buffer.from(String(value)));
    }
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface SsrfFetchInit { method?: string | undefined; headers?: Record<string, string> | undefined; body?: Buffer | string | undefined; form?: FormData | undefined }

/** Extra `https.request` options — production never sets this; test-only (a test CA to trust a local self-signed server). */
export interface TlsTestOptions { ca?: Buffer | string }

/**
 * The actual network connection, GIVEN an already deny-list-checked `pinnedIP` — no DNS lookup of
 * its own, no deny-list check (that already happened in `checkedAddress`, which every production
 * call path runs first). Separated out from `ssrfSafeFetch` so tests can exercise the connection
 * mechanics (pinning, no-redirects, size cap, timeout) against a real local server without needing
 * that server's address to itself pass the deny list. Never call this directly in production code —
 * `ssrfSafeFetch` is the only sanctioned entry point there.
 */
export async function connectPinned(url: string | URL, pinnedIP: string, init: SsrfFetchInit = {}, limits: FetchLimits = DEFAULT_FETCH_LIMITS, tls: TlsTestOptions = {}): Promise<Response> {
  const u = typeof url === "string" ? new URL(url) : url;

  let bodyBuf: Buffer | undefined;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.form) {
    const encoded = await encodeFormData(init.form);
    bodyBuf = encoded.body;
    headers["content-type"] = encoded.contentType;
  } else if (init.body !== undefined) {
    bodyBuf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
  }
  if (bodyBuf) headers["content-length"] = String(bodyBuf.length);

  // Bun's http client always requests `{ all: true }` and expects an address array back (unlike
  // Node, which only does that when the caller explicitly asks); handle both call shapes. `lookup`'s
  // real-world signature varies enough between Node and Bun that typing it precisely fights the
  // overloads more than it helps — `any` confined to this one options bag, nowhere else.
  const lookup = (_hostname: string, options: any, callback?: any) => {
    const family = pinnedIP.includes(":") ? 6 : 4;
    const cb = typeof options === "function" ? options : callback;
    const wantsAll = typeof options === "object" && !!options?.all;
    if (wantsAll) cb(null, [{ address: pinnedIP, family }]);
    else cb(null, pinnedIP, family);
  };

  return new Promise<Response>((resolvePromise, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname, // keeps the Host header and the TLS servername (SNI + cert check) on the real name
        port: Number(u.port) || 443,
        path: u.pathname + (u.search || ""),
        method: init.method ?? (bodyBuf ? "POST" : "GET"),
        headers,
        timeout: limits.timeoutMs,
        agent: false, // a fresh socket every time — never reuse a pooled connection across a different pinned IP
        ...(tls.ca ? { ca: tls.ca } : {}),
        lookup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see the `lookup` comment above
      } as any,
      (res) => {
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          res.resume();
          reject(new SsrfBlockedError(`upstream returned a redirect (${res.statusCode}); redirects are never followed`));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > limits.maxBytes) { res.resume(); reject(new Error(`response declares ${declared} bytes; the limit is ${limits.maxBytes}`)); return; }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limits.maxBytes) { req.destroy(); res.destroy(); reject(new Error(`response exceeded the ${limits.maxBytes}-byte cap`)); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const outHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) outHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
          resolvePromise(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: outHeaders }));
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request to "${u.hostname}" timed out after ${limits.timeoutMs}ms`)));
    req.on("error", reject);
    req.end(bodyBuf);
  });
}

/**
 * The only way outbound bytes leave the process for a client-named Rocket.Chat server: https only,
 * resolves and deny-checks the hostname itself, then connects to that checked (pinned) address —
 * see `connectPinned` — rather than letting the socket re-resolve. `resolver` is injectable so tests
 * never touch real DNS.
 */
export async function ssrfSafeFetch(url: string | URL, init: SsrfFetchInit = {}, limits: FetchLimits = DEFAULT_FETCH_LIMITS, resolver: Resolver = systemResolver): Promise<Response> {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "https:") throw new SsrfBlockedError(`only https is allowed, got "${u.protocol}"`);
  const pinnedIP = await checkedAddress(u.hostname, resolver);
  return connectPinned(u, pinnedIP, init, limits);
}
