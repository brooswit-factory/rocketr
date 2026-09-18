import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  url: string;
  userId: string;
  token: string;
  /** Usernames whose DMs and @mentions are pushed into sessions. Empty = push nothing. */
  allow: string[];
  pollMs: number;
  host: string;
  port: number;
}

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
  const userId = get("ROCKETR_USER_ID");
  const token = get("ROCKETR_TOKEN");
  const missing = [!url && "ROCKETR_URL", !userId && "ROCKETR_USER_ID", !token && "ROCKETR_TOKEN"].filter(Boolean);
  if (missing.length) throw new Error(`rocketr: missing ${missing.join(", ")} (env or ${file})`);

  const int = (k: string, d: number) => {
    const v = get(k);
    if (!v) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`rocketr: ${k} must be a non-negative integer, got "${v}"`);
    return n;
  };

  return {
    url, userId, token,
    allow: get("ROCKETR_ALLOW").split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean),
    pollMs: int("ROCKETR_POLL_MS", 3000),
    host: get("ROCKETR_HOST") || "127.0.0.1",
    port: int("ROCKETR_PORT", 8790),
  };
}
