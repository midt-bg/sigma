// Identity ⇄ URL slug mapping (pure; no DB). Domain ids are `'auth:'||ЕИК`, `'eik:'||ЕИК` (valid) /
// `'name:'||name` (no valid ЕИК), `'c:e:'||...` / `'c:o:'||...`. Authority/company routes use the ЕИК (clean,
// shareable, stable). A bidder without a valid ЕИК has no clean key, so its slug REVERSIBLY encodes
// the `name:` id as base64url — no stored slug column, no hash collisions, stable across rebuilds
// (it depends only on the normalised name). These entities are flagged „непотвърден ЕИК" and may
// fragment across name variants — a known limit until the Trade Register lands.

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const EIK_RE = /^\d{9}(\d{4})?$/;

/** bidder id → `/companies/:slug` segment. Valid ЕИК → the digits; name-keyed → `n` + base64url(name). */
export function companySlug(bidderId: string): string {
  if (bidderId.startsWith('eik:')) return bidderId.slice(4);
  if (bidderId.startsWith('name:')) return 'n' + b64urlEncode(bidderId.slice(5));
  return bidderId;
}

/** `/companies/:slug` segment → bidder id, or null if it cannot be decoded. */
export function bidderIdFromSlug(slug: string): string | null {
  if (EIK_RE.test(slug)) return 'eik:' + slug;
  if (slug.startsWith('n')) {
    try {
      return 'name:' + b64urlDecode(slug.slice(1));
    } catch {
      return null;
    }
  }
  return null;
}

/** authority id (`auth:ЕИК`) → `/authorities/:eik` segment. */
export function authoritySlug(authorityId: string): string {
  return authorityId.startsWith('auth:') ? authorityId.slice(5) : authorityId;
}

/** `/authorities/:eik` segment → authority id. */
export function authorityIdFromSlug(slug: string): string {
  return 'auth:' + slug;
}

/** contract id (`c:*`) → bare id without the leading `c:` prefix. This is the raw, un-encoded form
 *  — suitable for data export (CSV) where URL escaping is undesirable. Slug/href callers must layer
 *  `contractSlug` on top for path safety. */
export function bareContractId(contractId: string): string {
  return contractId.startsWith('c:') ? contractId.slice(2) : contractId;
}

/** contract id (`c:*`) → `/contracts/:id` segment (the id without the leading `c:`). Path-unsafe
 *  characters are percent-encoded: `%` first (to avoid mangling later replacements), then the URL
 *  structural chars `/`, `?`, `#`, plus whitespace and every Unicode control char via the `\p{Cc}`
 *  property (C0 U+0000–U+001F, DEL U+007F, C1 U+0080–U+009F). Encoding whitespace keeps the SSR-emitted
 *  href / sitemap `<loc>` a technically-valid URL when a domain id carries a space — e.g. a
 *  `contract_number` like `ОП 20-42` (review #221; a literal space in `<loc>` violates the sitemap spec).
 *  `\p{Cc}` is used rather than a raw code-point range so the class can't be misread as caret notation
 *  (`^@-^_`) in a diff viewer. Readable chars (incl. Cyrillic) and the structural `:` separators stay
 *  literal. React Router decodes these back in params, so `contractIdFromSlug` needs no change. */
export function contractSlug(contractId: string): string {
  return bareContractId(contractId)
    .replace(/%/g, '%25')
    .replace(/[/?#\s\p{Cc}]/gu, encodeURIComponent);
}

/** `/contracts/:id` segment → contract id. */
export function contractIdFromSlug(slug: string): string {
  return 'c:' + slug;
}

/** Map a raw domain id to its explorer route. Used to turn FTS `ref`s into hrefs. */
export function hrefForEntity(kind: 'authority' | 'company' | 'contract', id: string): string {
  if (kind === 'authority') return `/authorities/${authoritySlug(id)}`;
  if (kind === 'company') return `/companies/${companySlug(id)}`;
  return `/contracts/${contractSlug(id)}`;
}
