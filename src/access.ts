/**
 * The single pluggable access-check point (design v3.1, FACTORY-656 comment 29451). Called at
 * exactly one place in the codebase — twice conceptually: once when a connection is accepted
 * (before any outbound request) and once when a new credential key is first created — never
 * elsewhere. The SSRF deny list and the rate limits stay OUTSIDE this hook and are always on, so a
 * permissive (or even absent) policy here can never remove them.
 */
export interface AccessContext {
  /** The real client IP (post X-Forwarded-For resolution) — never the Caddy loopback peer. */
  sourceIP: string;
  /** The three credential headers, already redacted — never the raw values. */
  headers: Record<string, string>;
  /** The client-supplied Rocket.Chat base URL. */
  targetUrl: string;
  /** sha256(url, userId, token) — identifies the credential, never the token itself. */
  credentialKeyHash: string;
  /** Why this check is happening: a connection was accepted, or this is a brand-new credential key. */
  event: "connection" | "new-key";
}

export type AccessDecision = { allow: true } | { allow: false; reason: string };

export type CheckAccess = (ctx: AccessContext) => AccessDecision | Promise<AccessDecision>;

/** Today's policy: always allow. The hook exists so tomorrow's access-control phase is not a rewrite. */
export const allowAll: CheckAccess = () => ({ allow: true });
