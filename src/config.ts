import { homedir } from "node:os";
import { join } from "node:path";
import { isBindAllowed } from "./bind.js";
import { parseAttachmentTypes } from "./attachment-types.js";

/**
 * Everything rocketr holds any more: the bind address and port, in the process environment (the
 * systemd unit) — not a config file, nothing to reload. Every other setting the old per-account
 * config carried (accounts, tokens, client secrets, the unauthenticated-loopback flag) is gone:
 * the client's connection carries its own Rocket.Chat URL, credentials and options now.
 */
export interface Config {
  host: string;
  port: number;
  /** Where `download_attachment`'s local-save mode writes files (one subdirectory per account username). */
  attachmentDir: string;
  /** Largest attachment size `download_attachment` will fetch, in either mode (remote mode also clamps to a smaller effective cap — see tools.ts). */
  attachmentMaxBytes: number;
  /** MIME allowlist `download_attachment` enforces; exact types or `type/*` wildcards. */
  attachmentTypes: string[];
}

function int(env: Record<string, string | undefined>, k: string, d: number): number {
  const v = env[k];
  if (!v) return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`rocketr: ${k} must be a non-negative integer, got "${v}"`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const host = env.ROCKETR_HOST || "127.0.0.1";
  if (!isBindAllowed(host)) {
    throw new Error(`rocketr: ROCKETR_HOST ("${host}") is not loopback, the tailnet range (100.64.0.0/10), or a ULA address — refusing to bind a public interface`);
  }
  return {
    host,
    port: int(env, "ROCKETR_PORT", 8790),
    attachmentDir: env.ROCKETR_ATTACHMENT_DIR || join(homedir(), ".local", "share", "rocketr", "attachments"),
    attachmentMaxBytes: int(env, "ROCKETR_ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024),
    attachmentTypes: parseAttachmentTypes(env.ROCKETR_ATTACHMENT_TYPES),
  };
}
