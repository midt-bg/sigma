// Inline <script> tags only (no src=), capturing the opening-tag attributes and the script body.
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;

// The SSR render sets a per-request nonce CSP (entry.server.tsx); pull that nonce back out of the
// header so we can tell our own framework scripts (which carry it) apart from anything else in the
// body. Returns null in dev / non-HTML responses, where no nonce CSP is set.
export function cspNonce(headers: Headers): string | null {
  const match = headers.get('Content-Security-Policy')?.match(/'nonce-([^']+)'/);
  return match ? match[1] : null;
}

async function sha256Source(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return `'sha256-${btoa(binary)}'`;
}

// Hash ONLY the inline scripts that carry the per-request nonce — i.e. the framework boot/hydration
// scripts the SSR render emitted and trusts. The nonce is unforgeable (random per request, never
// echoed back to the client before render), so a hypothetically injected inline script can't carry
// it and is excluded from the hash allow-list — staying blocked by the resulting CSP. Hashing every
// <script> in the body instead (an earlier revision did) would self-authorize such an injection.
export async function hashTrustedInlineScripts(html: string, nonce: string): Promise<string[]> {
  const trusted = new Set<string>();
  for (const [, attrs, body] of html.matchAll(INLINE_SCRIPT_RE)) {
    const tag = attrs ?? '';
    if (tag.includes(`nonce="${nonce}"`) || tag.includes(`nonce='${nonce}'`)) {
      trusted.add(body ?? '');
    }
  }
  return Promise.all(Array.from(trusted).map(sha256Source));
}
