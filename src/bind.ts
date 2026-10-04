import { isLoopbackHost } from "./auth.js";
import { matchesCidr } from "./ssrf.js";

/** Tailnet range (Tailscale/100.64.0.0/10 CGNAT-shared space rocketr's own hosts use). */
const TAILNET: [string, number] = ["100.64.0.0", 10];
/** IPv6 Unique Local Address range. */
const ULA: [string, number] = ["fc00::", 7];

/**
 * Bind guard: refuses any bind address except loopback, the tailnet range, or a ULA address —
 * explicitly refuses `0.0.0.0` and any other public interface. There is no opt-in escape hatch:
 * rocketr sits behind Caddy (TLS termination, the only public listener) and binds loopback only in
 * every deployment this guard has to support, so the guard is unconditional.
 */
export function isBindAllowed(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  if (matchesCidr(host, ...TAILNET)) return true;
  if (matchesCidr(host, ...ULA)) return true;
  return false;
}
