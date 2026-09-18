import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseEnvFile } from "../../src/config.js";

const file = (text: string) => { const p = join(mkdtempSync(join(tmpdir(), "rocketr-")), "secrets.env"); writeFileSync(p, text); return p; };

describe("parseEnvFile", () => {
  test("reads KEY=value, skips comments and blanks, keeps '=' in values", () => {
    expect(parseEnvFile("# c\n\nA=1\n B = two \nC=x=y\nnope\n")).toEqual({ A: "1", B: "two", C: "x=y" });
  });
});

describe("loadConfig", () => {
  const base = "ROCKETCHAT_URL=https://chat.example/\nROCKETR_USER_ID=u\nROCKETR_TOKEN=t\n";

  test("falls back to ROCKETCHAT_URL, trims the trailing slash, applies defaults", () => {
    const c = loadConfig({ ROCKETR_ENV_FILE: file(base) });
    expect(c).toEqual({ url: "https://chat.example", userId: "u", token: "t", allow: [], pollMs: 3000, host: "127.0.0.1", port: 8790 });
  });

  test("process env wins over the file; allowlist strips @ and blanks", () => {
    const c = loadConfig({ ROCKETR_ENV_FILE: file(base + "ROCKETR_PORT=1\n"), ROCKETR_PORT: "9000", ROCKETR_ALLOW: "@boss, ,pal" });
    expect(c.port).toBe(9000);
    expect(c.allow).toEqual(["boss", "pal"]);
  });

  test("names every missing credential", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file("") })).toThrow("missing ROCKETR_URL, ROCKETR_USER_ID, ROCKETR_TOKEN");
  });

  test("rejects a non-integer number", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_POLL_MS: "soon" })).toThrow("ROCKETR_POLL_MS");
  });
});
