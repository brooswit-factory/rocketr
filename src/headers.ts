import { NOTIFY_LEVELS, type NotifyLevel } from "./rocketchat.js";

/** Compiled-in defaults and clamps for the client-carried connection options (design v3, FACTORY-656). */
export const POLL_FLOOR_MS = 3000;
export const DEFAULT_POLL_MS = 3000;
export const DEFAULT_BATCH_MS = 2000;
export const DEFAULT_LOOKBACK_SEC = 120;
/** A generous but bounded replay window — never unbounded, however large a client asks. */
export const MAX_LOOKBACK_SEC = 24 * 60 * 60;

export interface ParsedConnection {
  url: string;
  userId: string;
  token: string;
  notify: NotifyLevel;
  batchMs: number;
  pollMs: number;
  lookbackSec: number;
}

export interface HeaderError { field: string; message: string }

const get = (headers: Record<string, string | null | undefined>, k: string): string => headers[k] || "";

/** Parses and clamps the client-carried connection headers. Returns a `HeaderError` instead of throwing — the caller decides how to log/refuse. */
export function parseConnectionHeaders(headers: Record<string, string | null | undefined>): ParsedConnection | HeaderError {
  const url = get(headers, "x-rocketr-url").replace(/\/+$/, "");
  if (!url) return { field: "x-rocketr-url", message: "missing" };
  if (!/^https:\/\//i.test(url)) return { field: "x-rocketr-url", message: "must be an https:// URL" };
  const userId = get(headers, "x-rocketr-user-id");
  if (!userId) return { field: "x-rocketr-user-id", message: "missing" };
  const token = get(headers, "x-rocketr-token");
  if (!token) return { field: "x-rocketr-token", message: "missing" };

  const notify = get(headers, "x-rocketr-notify") || "mentions";
  if (!(NOTIFY_LEVELS as readonly string[]).includes(notify)) {
    return { field: "x-rocketr-notify", message: `must be one of ${NOTIFY_LEVELS.join(", ")}` };
  }

  const int = (k: string, d: number): number | HeaderError => {
    const v = get(headers, k);
    if (!v) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { field: k, message: "must be a non-negative integer" };
    return Math.floor(n);
  };
  const batchMs = int("x-rocketr-batch-ms", DEFAULT_BATCH_MS);
  if (typeof batchMs !== "number") return batchMs;
  const pollMsRaw = int("x-rocketr-poll-ms", DEFAULT_POLL_MS);
  if (typeof pollMsRaw !== "number") return pollMsRaw;
  const lookbackSecRaw = int("x-rocketr-lookback-sec", DEFAULT_LOOKBACK_SEC);
  if (typeof lookbackSecRaw !== "number") return lookbackSecRaw;

  return {
    url, userId, token,
    notify: notify as NotifyLevel,
    batchMs,
    pollMs: Math.max(pollMsRaw, POLL_FLOOR_MS), // server-side clamp: the poll floor
    lookbackSec: Math.min(lookbackSecRaw, MAX_LOOKBACK_SEC),
  };
}

export function isHeaderError(x: ParsedConnection | HeaderError): x is HeaderError {
  return "field" in x && "message" in x;
}

/** The three raw credential values straight off an established `Connection`'s headers — same normalization as `parseConnectionHeaders`, so the key this computes always matches the one computed at connect time. */
export function connectionCredentials(headers: Record<string, string | null | undefined>): { url: string; userId: string; token: string } {
  return { url: get(headers, "x-rocketr-url").replace(/\/+$/, ""), userId: get(headers, "x-rocketr-user-id"), token: get(headers, "x-rocketr-token") };
}

