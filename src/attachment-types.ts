/** `download_attachment`'s allowlist: images, audio, PDF and plain text by default — configurable (FACTORY-593 nit 2) via `ROCKETR_ATTACHMENT_TYPES`, a comma-separated list of exact MIME types or `type/*` wildcards. */
export const DEFAULT_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "audio/*", "application/pdf", "text/plain"];

export function parseAttachmentTypes(spec: string | undefined): string[] {
  if (!spec) return DEFAULT_ATTACHMENT_TYPES;
  const list = spec.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ATTACHMENT_TYPES;
}

export function attachmentAllowed(mime: string, allow: readonly string[] = DEFAULT_ATTACHMENT_TYPES): boolean {
  return allow.some((pattern) => (pattern.endsWith("/*") ? mime.startsWith(pattern.slice(0, -1)) : mime === pattern));
}
