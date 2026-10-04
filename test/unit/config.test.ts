import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  test("defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8790);
    expect(cfg.attachmentMaxBytes).toBe(25 * 1024 * 1024);
    expect(cfg.attachmentTypes.length).toBeGreaterThan(0);
  });

  test("ROCKETR_HOST / ROCKETR_PORT override the defaults", () => {
    const cfg = loadConfig({ ROCKETR_HOST: "::1", ROCKETR_PORT: "9999" });
    expect(cfg.host).toBe("::1");
    expect(cfg.port).toBe(9999);
  });

  test("the tailnet range and a ULA address are accepted binds", () => {
    expect(() => loadConfig({ ROCKETR_HOST: "100.64.1.2" })).not.toThrow();
    expect(() => loadConfig({ ROCKETR_HOST: "fc00::1" })).not.toThrow();
  });

  test("a public bind is refused outright — no opt-in", () => {
    expect(() => loadConfig({ ROCKETR_HOST: "0.0.0.0" })).toThrow();
    expect(() => loadConfig({ ROCKETR_HOST: "203.0.113.5" })).toThrow();
  });

  test("ROCKETR_PORT must be a non-negative integer", () => {
    expect(() => loadConfig({ ROCKETR_PORT: "-1" })).toThrow();
    expect(() => loadConfig({ ROCKETR_PORT: "abc" })).toThrow();
  });

  test("ROCKETR_ATTACHMENT_TYPES overrides the default allowlist", () => {
    const cfg = loadConfig({ ROCKETR_ATTACHMENT_TYPES: "text/plain,application/json" });
    expect(cfg.attachmentTypes).toEqual(["text/plain", "application/json"]);
  });

  test("ROCKETR_ATTACHMENT_DIR / ROCKETR_ATTACHMENT_MAX_BYTES override the defaults", () => {
    const cfg = loadConfig({ ROCKETR_ATTACHMENT_DIR: "/tmp/x", ROCKETR_ATTACHMENT_MAX_BYTES: "1000" });
    expect(cfg.attachmentDir).toBe("/tmp/x");
    expect(cfg.attachmentMaxBytes).toBe(1000);
  });

  test("there is no account registry, URL, or client-secret configuration any more", () => {
    const cfg = loadConfig({});
    expect(cfg).not.toHaveProperty("accounts");
    expect(cfg).not.toHaveProperty("url");
    expect(cfg).not.toHaveProperty("allowUnauthenticatedLoopback");
  });
});
