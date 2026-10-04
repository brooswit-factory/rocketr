import { describe, expect, test } from "bun:test";
import { realClientIP } from "../../src/forwarded.js";

describe("realClientIP", () => {
  test("trusts X-Forwarded-For when the direct peer is loopback (Caddy)", () => {
    expect(realClientIP("127.0.0.1", "203.0.113.5")).toBe("203.0.113.5");
  });

  test("takes the right-most entry — the hop closest to us, the only one Caddy itself appends", () => {
    expect(realClientIP("127.0.0.1", "203.0.113.5, 10.0.0.1")).toBe("10.0.0.1");
  });

  test("a spoofed X-Forwarded-For from a NON-loopback peer is ignored outright — the peer address wins", () => {
    expect(realClientIP("198.51.100.9", "1.2.3.4")).toBe("198.51.100.9");
  });

  test("no X-Forwarded-For at all just uses the peer", () => {
    expect(realClientIP("127.0.0.1", null)).toBe("127.0.0.1");
    expect(realClientIP("127.0.0.1", undefined)).toBe("127.0.0.1");
  });

  test("an empty peer with no header is reported as unknown rather than throwing", () => {
    expect(realClientIP(undefined, null)).toBe("unknown");
  });

  test("::1 (IPv6 loopback) also counts as the trusted Caddy peer", () => {
    expect(realClientIP("::1", "203.0.113.5")).toBe("203.0.113.5");
  });
});
