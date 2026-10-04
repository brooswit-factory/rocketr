import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkedAddress, connectPinned, encodeFormData, isDeniedAddress, matchesCidr, resolveAllAddresses, ssrfSafeFetch, SsrfBlockedError, type Resolver,
} from "../../src/ssrf.js";

describe("isDeniedAddress — the compiled-in deny list", () => {
  test("IPv4 loopback", () => expect(isDeniedAddress("127.0.0.1")).toBe(true));
  test("IPv4 RFC1918", () => {
    expect(isDeniedAddress("10.1.2.3")).toBe(true);
    expect(isDeniedAddress("172.16.0.1")).toBe(true);
    expect(isDeniedAddress("172.31.255.255")).toBe(true);
    expect(isDeniedAddress("172.32.0.1")).toBe(false); // just outside the /12
    expect(isDeniedAddress("192.168.1.1")).toBe(true);
  });
  test("IPv4 link-local, including the cloud metadata address", () => {
    expect(isDeniedAddress("169.254.0.1")).toBe(true);
    expect(isDeniedAddress("169.254.169.254")).toBe(true);
  });
  test("CGNAT 100.64.0.0/10", () => {
    expect(isDeniedAddress("100.64.0.1")).toBe(true);
    expect(isDeniedAddress("100.100.0.1")).toBe(true);
    expect(isDeniedAddress("100.128.0.1")).toBe(false);
  });
  test("0.0.0.0/8 and the broadcast address", () => {
    expect(isDeniedAddress("0.0.0.0")).toBe(true);
    expect(isDeniedAddress("0.1.2.3")).toBe(true);
    expect(isDeniedAddress("255.255.255.255")).toBe(true);
  });
  test("IPv4 multicast", () => expect(isDeniedAddress("224.0.0.1")).toBe(true));
  test("a normal public IPv4 address is allowed", () => {
    expect(isDeniedAddress("8.8.8.8")).toBe(false);
    expect(isDeniedAddress("1.1.1.1")).toBe(false);
  });

  test("IPv6 loopback and unspecified", () => {
    expect(isDeniedAddress("::1")).toBe(true);
    expect(isDeniedAddress("::")).toBe(true);
  });
  test("IPv6 unique local (fc00::/7)", () => {
    expect(isDeniedAddress("fc00::1")).toBe(true);
    expect(isDeniedAddress("fd12:3456::1")).toBe(true);
  });
  test("IPv6 link-local (fe80::/10)", () => expect(isDeniedAddress("fe80::1")).toBe(true));
  test("IPv6 multicast (ff00::/8)", () => expect(isDeniedAddress("ff02::1")).toBe(true));
  test("a normal public IPv6 address is allowed", () => expect(isDeniedAddress("2001:db8::1")).toBe(false));

  test("IPv4-mapped IPv6: the embedded v4 address is checked too", () => {
    expect(isDeniedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isDeniedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isDeniedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isDeniedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("an unparsable address is refused rather than let through", () => {
    expect(isDeniedAddress("not-an-ip")).toBe(true);
  });

  // Manager review on PR #14 (comment 29464): every one of these previously came back NOT denied,
  // because the old check only matched the dotted-decimal mapped form by string regex. These are
  // now checked on the 128-bit VALUE, so the resolver's own textual formatting can't evade it.
  test("every IPv6 form that embeds an IPv4 address is caught, regardless of notation", () => {
    expect(isDeniedAddress("::ffff:7f00:1")).toBe(true);          // mapped, hex form — loopback
    expect(isDeniedAddress("::ffff:a9fe:a9fe")).toBe(true);       // mapped, hex form — cloud metadata address
    expect(isDeniedAddress("64:ff9b::7f00:1")).toBe(true);        // NAT64 — loopback
    expect(isDeniedAddress("2002:7f00:1::")).toBe(true);          // 6to4 — loopback
    expect(isDeniedAddress("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBe(true); // Teredo embedding 192.0.2.45 (now itself denied, TEST-NET-1)
    expect(isDeniedAddress("::127.0.0.1")).toBe(true);            // deprecated IPv4-compatible form — loopback
  });

  test("extra reserved/benchmarking/TEST-NET ranges added on review", () => {
    expect(isDeniedAddress("240.0.0.1")).toBe(true);
    expect(isDeniedAddress("192.0.0.1")).toBe(true);
    expect(isDeniedAddress("198.18.0.1")).toBe(true);
    expect(isDeniedAddress("192.0.2.1")).toBe(true);
    expect(isDeniedAddress("198.51.100.1")).toBe(true);
    expect(isDeniedAddress("203.0.113.1")).toBe(true);
  });
});

describe("matchesCidr", () => {
  test("v4 and v6", () => {
    expect(matchesCidr("10.1.2.3", "10.0.0.0", 8)).toBe(true);
    expect(matchesCidr("11.1.2.3", "10.0.0.0", 8)).toBe(false);
    expect(matchesCidr("fc00::5", "fc00::", 7)).toBe(true);
  });
});

function fakeResolver(answers: { v4?: string[]; v6?: string[] }): Resolver {
  return {
    resolve4: async () => answers.v4 ?? [],
    resolve6: async () => answers.v6 ?? [],
  };
}

describe("resolveAllAddresses / checkedAddress", () => {
  test("throws when DNS returns nothing at all", async () => {
    await expect(resolveAllAddresses("x.invalid", fakeResolver({}))).rejects.toThrow(/no A\/AAAA/);
  });

  test("checkedAddress refuses when ANY resolved address is denied — one public, one private", async () => {
    const resolver = fakeResolver({ v4: ["8.8.8.8", "10.0.0.1"] });
    await expect(checkedAddress("mixed.invalid", resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test("checkedAddress accepts and pins the first address when every record is public", async () => {
    const resolver = fakeResolver({ v4: ["8.8.8.8", "8.8.4.4"] });
    expect(await checkedAddress("public.invalid", resolver)).toBe("8.8.8.8");
  });

  test("a v6-only answer is checked the same way", async () => {
    const resolver = fakeResolver({ v6: ["fc00::1"] });
    await expect(checkedAddress("v6.invalid", resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("ssrfSafeFetch", () => {
  test("refuses anything but https", async () => {
    await expect(ssrfSafeFetch("http://example.com/", {}, undefined, fakeResolver({ v4: ["8.8.8.8"] }))).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test("refuses a target that resolves to a denied address, before any connection is attempted", async () => {
    await expect(ssrfSafeFetch("https://internal.invalid/", {}, undefined, fakeResolver({ v4: ["127.0.0.1"] }))).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test("refuses any port but 443 — a TLS-handshake probe primitive otherwise (review item 5a) — without even consulting DNS", async () => {
    let dnsCalled = false;
    const resolver: Resolver = { resolve4: async () => { dnsCalled = true; return ["127.0.0.1"]; }, resolve6: async () => [] };
    await expect(ssrfSafeFetch("https://public.invalid:6379/", {}, undefined, resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(dnsCalled).toBe(false);

    // Port 443 (explicit or default) gets PAST the port check — it reaches the resolver stage, and
    // fails there instead (the deny-listed fake address), never for a port reason.
    dnsCalled = false;
    await expect(ssrfSafeFetch("https://public.invalid:443/", {}, undefined, resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(dnsCalled).toBe(true);
  });

  test("refuses an IP-literal hostname outright, explicitly — not merely because DNS returns nothing for it (review item 5b)", async () => {
    let dnsCalled = false;
    const resolver: Resolver = { resolve4: async () => { dnsCalled = true; return ["8.8.8.8"]; }, resolve6: async () => [] };
    await expect(ssrfSafeFetch("https://8.8.8.8/", {}, undefined, resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(ssrfSafeFetch("https://[2001:db8::1]/", {}, undefined, resolver)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(dnsCalled).toBe(false); // refused before DNS is ever consulted
  });
});

/** A local HTTPS server + self-signed cert, so connectPinned's actual network mechanics (pinning,
 * no-redirects, size cap, timeout) can be exercised without the target address needing to pass the
 * deny list — see connectPinned's own doc comment for why it's the right seam for this. */
describe("connectPinned (real network, deny-list bypassed on purpose — see its doc comment)", () => {
  let server: Server;
  let port: number;
  let certDir: string;
  let ca: string;
  const HOSTNAME = "ssrf-test.invalid";

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), "rocketr-ssrf-test-"));
    const keyPath = join(certDir, "key.pem"), certPath = join(certDir, "cert.pem");
    const gen = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", `/CN=${HOSTNAME}`, "-addext", `subjectAltName=DNS:${HOSTNAME}`,
    ]);
    if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`);
    ca = await Bun.file(certPath).text();
    const key = await Bun.file(keyPath).text();

    await new Promise<void>((resolve) => {
      server = createServer({ key, cert: ca }, (req, res) => {
        if (req.url === "/redirect") { res.writeHead(302, { location: "https://internal.example/secret" }); res.end(); return; }
        if (req.url === "/big") { res.writeHead(200, { "content-length": "1000000" }); res.end("x".repeat(1_000_000)); return; }
        if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("done"); }, 2000); return; }
        if (req.url === "/trickle") {
          res.writeHead(200);
          let n = 0;
          const iv = setInterval(() => { res.write("x"); if (++n >= 40) { clearInterval(iv); res.end(); } }, 60);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello from " + req.url);
      });
      server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(certDir, { recursive: true, force: true });
  });

  test("connects to the PINNED address, not whatever the hostname would really resolve to — defeats rebinding", async () => {
    // HOSTNAME doesn't resolve via real DNS at all; the only reason this succeeds is the pinned lookup override.
    const res = await connectPinned(`https://${HOSTNAME}:${port}/ping`, "127.0.0.1", {}, undefined, { ca });
    expect(await res.text()).toBe("hello from /ping");
  });

  test("never follows a redirect", async () => {
    await expect(connectPinned(`https://${HOSTNAME}:${port}/redirect`, "127.0.0.1", {}, undefined, { ca })).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test("enforces the response size cap against the actual bytes received", async () => {
    await expect(connectPinned(`https://${HOSTNAME}:${port}/big`, "127.0.0.1", {}, { timeoutMs: 5000, maxBytes: 1000 }, { ca })).rejects.toThrow(/limit/);
  });

  test("enforces a timeout — the slow endpoint takes 2s, but the call rejects well before that", async () => {
    const t0 = Date.now();
    await expect(connectPinned(`https://${HOSTNAME}:${port}/slow`, "127.0.0.1", {}, { timeoutMs: 500, maxBytes: 10_000 }, { ca })).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("the deadline is a WALL-CLOCK bound, not an idle timeout — a trickling server (never idle, never over the size cap) still gets cut off (review item 4)", async () => {
    const t0 = Date.now();
    // /trickle writes one byte every 60ms for 40 writes (~2.4s total), each gap far under the idle
    // timeout — an idle-only timeout would never fire here, and the response never reaches the size cap.
    await expect(connectPinned(`https://${HOSTNAME}:${port}/trickle`, "127.0.0.1", {}, { timeoutMs: 600, maxBytes: 10_000 }, { ca })).rejects.toThrow(/deadline/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("encodeFormData", () => {
  test("encodes a text field and a file field as multipart/form-data", async () => {
    const form = new FormData();
    form.set("name", "value");
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }), "f.bin");
    const { body, contentType } = await encodeFormData(form);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = body.toString("latin1");
    expect(text).toContain('name="name"');
    expect(text).toContain("value");
    expect(text).toContain('filename="f.bin"');
  });
});
