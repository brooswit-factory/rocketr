/** The three per-connection credential headers. Never logged, echoed, or shown in the observer app. */
export const CREDENTIAL_HEADERS = ["x-rocketr-url", "x-rocketr-user-id", "x-rocketr-token"] as const;

/** Headers safe to show as-is in logs, errors, and the observer snapshot. */
const SAFE_HEADERS = ["x-rocketr-notify", "x-rocketr-batch-ms", "x-rocketr-poll-ms", "x-rocketr-lookback-sec", "x-agent-name", "x-rocketr-channel", "user-agent"] as const;

/** Every credential header replaced with `[redacted]`; everything else not in the known-safe allowlist dropped too. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of CREDENTIAL_HEADERS) if (headers[h] !== undefined) out[h] = "[redacted]";
  for (const h of SAFE_HEADERS) if (headers[h] !== undefined) out[h] = headers[h]!;
  return out;
}

/** The hostname of a client-supplied URL, for counters/alerts — never the full URL (which could carry a path or query the client controls, even though today's header is just a base URL). */
export function targetHost(url: string): string {
  try { return new URL(url).hostname; } catch { return "[unparsable]"; }
}
