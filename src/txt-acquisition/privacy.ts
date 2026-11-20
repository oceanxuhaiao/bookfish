import { createHash } from 'node:crypto';

/** Records keep only the public origin and a digest. Paths can contain bearer tokens too. */
export function sourceReference(raw: string): { url: string; sha256: string; requiresRediscovery: boolean } {
  const parsed = new URL(raw);
  return { url: parsed.origin, sha256: createHash('sha256').update(raw).digest('hex'), requiresRediscovery: parsed.pathname !== '/' || Boolean(parsed.search || parsed.hash || parsed.username || parsed.password) };
}
export function redactMessage(raw: string): string {
  return String(raw).replace(/https?:\/\/[^\s<>"']+/giu, '[source URL redacted]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, '[authorization redacted]')
    .replace(/\b(?:cookie|authorization|token|signature|password|secret)\s*[:=]\s*[^\s,;]+/giu, '[credential redacted]').slice(0, 300);
}
