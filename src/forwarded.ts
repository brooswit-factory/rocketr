import { isLoopbackAddress } from "./auth.js";

/**
 * The real client IP for rate limiting and counters. rocketr binds loopback only; Caddy is the one
 * public listener and proxies to it over loopback, so every direct TCP peer IS Caddy. `X-Forwarded-For`
 * is trusted ONLY when the direct peer is loopback (i.e. it really did come from our own reverse
 * proxy) and only its right-most entry is used (the hop closest to us — the only one Caddy itself
 * appends, so it can't be spoofed by anything upstream of Caddy). From any other peer the header is
 * ignored outright and the peer address is used instead, so nothing but Caddy can claim an IP for itself.
 */
export function realClientIP(peerAddress: string | undefined, forwardedFor: string | null | undefined): string {
  if (isLoopbackAddress(peerAddress) && forwardedFor) {
    const parts = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return peerAddress ?? "unknown";
}
