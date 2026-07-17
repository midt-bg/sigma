// Client-side link-protocol allowlist for rendered report markdown (spec §D3 / §7).
//
// The server already strips HTML via sanitizeProse (report-schema.ts), but the renderer must also
// refuse dangerous link schemes — a markdown `[text](javascript:…)` is not inside an HTML tag, so
// the tag strip misses it. This module is the authoritative client-side guard; import it from any
// markdown renderer that touches report text or callout blocks.

// Permitted URL protocols for report prose links. No mailto — report text does not need it.
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * True if the href is safe to render as an anchor href.
 *
 * Permits http:, https:, and scheme-free relative paths (path-absolute `/foo`, relative `./x`,
 * fragment `#id`, query `?q=1`). Refuses javascript:, data:, file:, blob:, vbscript:, etc.
 *
 * Detection strategy: a colon before any `/`, `?`, or `#` indicates a URL scheme; validate it
 * against SAFE_PROTOCOLS. A colon that appears AFTER the first path separator is part of a path
 * segment (e.g. `/reports/:id`) — treated as a relative URL and allowed.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;

  // Protocol-relative URLs (//host or \\host) are not relative paths — they resolve to an
  // external origin and bypass the scheme check below. Reject them explicitly.
  if (/^[/\\]{2}/.test(trimmed)) return false;

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return true; // no colon → scheme-free relative URL → safe

  // A slash, `?`, or `#` BEFORE the colon means the colon is in a path/query/fragment, not a scheme.
  const firstSep = trimmed.search(/[/?#]/);
  if (firstSep !== -1 && firstSep < colonIdx) return true;

  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/**
 * Returns the href unchanged when safe, null when not.
 * Callers must NOT render an `<a>` element when this returns null.
 */
export function sanitizeLinkHref(href: string): string | null {
  return isSafeHref(href) ? href : null;
}
