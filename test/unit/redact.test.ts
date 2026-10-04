import { describe, expect, test } from "bun:test";
import { redactHeaders, targetHost } from "../../src/redact.js";

describe("redactHeaders", () => {
  test("the three credential headers are always redacted, never the raw value", () => {
    const out = redactHeaders({
      "x-rocketr-url": "https://chat.example.com",
      "x-rocketr-user-id": "u1",
      "x-rocketr-token": "super-secret-token",
      "x-agent-name": "main",
    });
    expect(out["x-rocketr-url"]).toBe("[redacted]");
    expect(out["x-rocketr-user-id"]).toBe("[redacted]");
    expect(out["x-rocketr-token"]).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
    expect(out["x-agent-name"]).toBe("main");
  });

  test("an unrecognized header is dropped entirely, not passed through", () => {
    const out = redactHeaders({ "x-made-up": "whatever", cookie: "session=abc" });
    expect(out).toEqual({});
  });

  test("absent headers just don't appear in the output", () => {
    expect(redactHeaders({})).toEqual({});
  });
});

describe("targetHost", () => {
  test("extracts just the hostname", () => {
    expect(targetHost("https://chat.example.com/some/path")).toBe("chat.example.com");
  });
  test("an unparsable URL doesn't throw", () => {
    expect(targetHost("not a url")).toBe("[unparsable]");
  });
});
