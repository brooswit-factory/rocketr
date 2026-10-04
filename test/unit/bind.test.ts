import { describe, expect, test } from "bun:test";
import { isBindAllowed } from "../../src/bind.js";

describe("isBindAllowed", () => {
  test("loopback forms", () => {
    expect(isBindAllowed("127.0.0.1")).toBe(true);
    expect(isBindAllowed("::1")).toBe(true);
    expect(isBindAllowed("localhost")).toBe(true);
  });
  test("the tailnet range 100.64.0.0/10", () => {
    expect(isBindAllowed("100.64.0.0")).toBe(true);
    expect(isBindAllowed("100.64.1.2")).toBe(true);
    expect(isBindAllowed("100.127.255.255")).toBe(true);
    expect(isBindAllowed("100.128.0.0")).toBe(false); // just outside /10
    expect(isBindAllowed("100.63.255.255")).toBe(false);
  });
  test("a ULA address (fc00::/7)", () => {
    expect(isBindAllowed("fc00::1")).toBe(true);
    expect(isBindAllowed("fd12:3456:789a::1")).toBe(true);
    expect(isBindAllowed("fe00::1")).toBe(false); // just outside /7
  });
  test("refuses 0.0.0.0 and any public interface", () => {
    expect(isBindAllowed("0.0.0.0")).toBe(false);
    expect(isBindAllowed("203.0.113.5")).toBe(false);
    expect(isBindAllowed("8.8.8.8")).toBe(false);
    expect(isBindAllowed("2001:db8::1")).toBe(false);
  });
});
