import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { NOTIFY_LEVELS, type NotifyLevel } from "./rocketchat.js";

export interface AccountConfig {
  /** The Rocket.Chat username. Connections select it with `x-rocketr-account: <name>`. */
  name: string;
  userId: string;
  token: string;
}

export interface Config {
  url: string;
  /** Every account rocketr signs in as. There is no default: a connection must name one. */
  accounts: AccountConfig[];
  /**
   * Opt-in, single-account bridges only (`ROCKETR_DEFAULT_ACCOUNT`): a connection that sends no
   * `x-rocketr-account` acts as this account. For clients that cannot set headers (e.g. Codex under Butchr).
   */
  defaultAccount?: string;
  /**
   * Level saved on each account's rooms that have no preference yet (at startup and when the account joins one),
   * and assumed for a room until that save lands. Each room's own Rocket.Chat preference then decides what is pushed.
   */
  defaultNotifications: NotifyLevel;
  /** One-shot recovery switch: replace legacy broad room preferences with mention-only delivery. */
  migrateLegacyAllToMentions: boolean;
  /** Messages in one room and thread arriving within this many ms of each other become one turn. 0 = no batching. */
  batchMs: number;
  pollMs: number;
  host: string;
  port: number;
}

/** `rocketr-lead` → `ROCKETR_ACCOUNT_ROCKETR_LEAD_` */
export const accountKey = (name: string) => `ROCKETR_ACCOUNT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "rocketchat", "secrets.env");

/** `KEY=value` lines; `#` comments and blanks ignored; no quoting or interpolation. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Process env wins over the env file, so a unit or shell can override one value. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = env.ROCKETR_ENV_FILE ?? DEFAULT_ENV_FILE;
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const get = (k: string) => env[k] || fromFile[k] || "";

  const url = (get("ROCKETR_URL") || get("ROCKETCHAT_URL")).replace(/\/+$/, "");
  if (!url) throw new Error(`rocketr: missing ROCKETR_URL (env or ${file})`);

  const names = get("ROCKETR_ACCOUNTS").split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  if (!names.length) throw new Error(`rocketr: ROCKETR_ACCOUNTS is empty — list the usernames rocketr signs in as (env or ${file})`);
  const accounts = names.map((name) => {
    const k = accountKey(name);
    const userId = get(`${k}USER_ID`), token = get(`${k}TOKEN`);
    const missing = [!userId && `${k}USER_ID`, !token && `${k}TOKEN`].filter(Boolean);
    if (missing.length) throw new Error(`rocketr: account ${name}: missing ${missing.join(", ")}`);
    return { name, userId, token };
  });

  const defaultAccount = get("ROCKETR_DEFAULT_ACCOUNT").replace(/^@/, "") || undefined;
  if (defaultAccount && (names.length !== 1 || names[0] !== defaultAccount)) {
    throw new Error(`rocketr: ROCKETR_DEFAULT_ACCOUNT needs exactly one account in ROCKETR_ACCOUNTS, and it must be that one (got "${defaultAccount}" for ${names.join(", ")})`);
  }

  const int = (k: string, d: number) => {
    const v = get(k);
    if (!v) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`rocketr: ${k} must be a non-negative integer, got "${v}"`);
    return n;
  };
  const bool = (k: string) => {
    const v = get(k);
    if (!v) return false;
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
    throw new Error(`rocketr: ${k} must be true or false, got "${v}"`);
  };

  // Public rooms are noisy by default. Agents still receive DMs, @mentions, and
  // replies in followed threads, while a deliberate room setting can opt into all.
  const level = get("ROCKETR_DEFAULT_NOTIFICATIONS") || "mentions";
  if (!(NOTIFY_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`rocketr: ROCKETR_DEFAULT_NOTIFICATIONS must be one of ${NOTIFY_LEVELS.join(", ")}, got "${level}"`);
  }

  return {
    url, accounts, ...(defaultAccount ? { defaultAccount } : {}),
    defaultNotifications: level as NotifyLevel,
    migrateLegacyAllToMentions: bool("ROCKETR_MIGRATE_LEGACY_ALL_TO_MENTIONS"),
    batchMs: int("ROCKETR_BATCH_MS", 2000),
    pollMs: int("ROCKETR_POLL_MS", 3000),
    host: get("ROCKETR_HOST") || "127.0.0.1",
    port: int("ROCKETR_PORT", 8790),
  };
}
