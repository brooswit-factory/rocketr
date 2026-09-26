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
  const base = "ROCKETCHAT_URL=https://chat.example/\nROCKETR_ACCOUNTS=claude, @rocketr-lead\n" +
    "ROCKETR_ACCOUNT_CLAUDE_USER_ID=u1\nROCKETR_ACCOUNT_CLAUDE_TOKEN=t1\n" +
    "ROCKETR_ACCOUNT_ROCKETR_LEAD_USER_ID=u2\nROCKETR_ACCOUNT_ROCKETR_LEAD_TOKEN=t2\n";

  test("reads every account, falls back to ROCKETCHAT_URL, trims the slash, applies defaults", () => {
    expect(loadConfig({ ROCKETR_ENV_FILE: file(base) })).toEqual({
      url: "https://chat.example",
      accounts: [{ name: "claude", userId: "u1", token: "t1" }, { name: "rocketr-lead", userId: "u2", token: "t2" }],
      defaultNotifications: "mentions", migrateLegacyAllToMentions: false, batchMs: 2000, pollMs: 3000, host: "127.0.0.1", port: 8790,
    });
  });

  test("process env wins over the file", () => {
    const c = loadConfig({ ROCKETR_ENV_FILE: file(base + "ROCKETR_PORT=1\n"), ROCKETR_PORT: "9000", ROCKETR_DEFAULT_NOTIFICATIONS: "mentions" });
    expect(c.port).toBe(9000);
    expect(c.defaultNotifications).toBe("mentions");
  });

  test("accepts an explicit one-shot legacy notification migration", () => {
    expect(loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_MIGRATE_LEGACY_ALL_TO_MENTIONS: "true" }).migrateLegacyAllToMentions).toBe(true);
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_MIGRATE_LEGACY_ALL_TO_MENTIONS: "yes" })).toThrow("ROCKETR_MIGRATE_LEGACY_ALL_TO_MENTIONS");
  });

  test("rejects an unknown notification level", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_DEFAULT_NOTIFICATIONS: "loud" })).toThrow("ROCKETR_DEFAULT_NOTIFICATIONS");
  });

  test("requires the URL", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file("ROCKETR_ACCOUNTS=a\n") })).toThrow("missing ROCKETR_URL");
  });

  test("requires at least one account — there is no default", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file("ROCKETR_URL=https://x\n") })).toThrow("ROCKETR_ACCOUNTS is empty");
  });

  test("names the missing credentials of an account", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file("ROCKETR_URL=https://x\nROCKETR_ACCOUNTS=rocketr-lead\n") }))
      .toThrow("account rocketr-lead: missing ROCKETR_ACCOUNT_ROCKETR_LEAD_USER_ID, ROCKETR_ACCOUNT_ROCKETR_LEAD_TOKEN");
  });

  test("ROCKETR_DEFAULT_ACCOUNT opts a single-account bridge into serving headerless clients", () => {
    const one = "ROCKETR_URL=https://x\nROCKETR_ACCOUNTS=dev-zippy\nROCKETR_ACCOUNT_DEV_ZIPPY_USER_ID=u\nROCKETR_ACCOUNT_DEV_ZIPPY_TOKEN=t\n";
    expect(loadConfig({ ROCKETR_ENV_FILE: file(one) }).defaultAccount).toBeUndefined();
    expect(loadConfig({ ROCKETR_ENV_FILE: file(one), ROCKETR_DEFAULT_ACCOUNT: "@dev-zippy" }).defaultAccount).toBe("dev-zippy");
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(one), ROCKETR_DEFAULT_ACCOUNT: "other" })).toThrow("ROCKETR_DEFAULT_ACCOUNT");
  });

  test("ROCKETR_DEFAULT_ACCOUNT is refused on a multi-account bridge", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_DEFAULT_ACCOUNT: "claude" })).toThrow("exactly one account");
  });

  test("rejects a non-integer number", () => {
    expect(() => loadConfig({ ROCKETR_ENV_FILE: file(base), ROCKETR_POLL_MS: "soon" })).toThrow("ROCKETR_POLL_MS");
  });
});
