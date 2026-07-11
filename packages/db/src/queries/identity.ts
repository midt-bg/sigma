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

/** person id (`person:<name-key>`) → `/conflicts/official/:slug` segment. The key is uppercase Cyrillic
 *  with spaces (companyNameKey output) — not URL-clean — so base64url it, like a name-keyed bidder. Stable
 *  across rebuilds (depends only on the normalised name); never split-parses the `|` that link_key uses. */
export function personSlug(personId: string): string {
  return b64urlEncode(personId.startsWith('person:') ? personId.slice(7) : personId);
}

/** `/conflicts/official/:slug` segment → person id, or null if the slug cannot be decoded. */
export function personIdFromSlug(slug: string): string | null {
  try {
    return 'person:' + b64urlDecode(slug);
  } catch {
    return null;
  }
}

/** authority id (`auth:ЕИК`) → `/authorities/:eik` segment. */
export function authoritySlug(authorityId: string): string {
  return authorityId.startsWith('auth:') ? authorityId.slice(5) : authorityId;
}

/** `/authorities/:eik` segment → authority id. */
export function authorityIdFromSlug(slug: string): string {
  return 'auth:' + slug;
}

/** contract id (`c:*`) → `/contracts/:id` segment (the id without the leading `c:`). */
export function contractSlug(contractId: string): string {
  return contractId.startsWith('c:') ? contractId.slice(2) : contractId;
}

/** `/contracts/:id` segment → contract id. */
export function contractIdFromSlug(slug: string): string {
  return 'c:' + slug;
}

/** Map a raw domain id to its explorer route. Used to turn FTS `ref`s into hrefs. */
export function hrefForEntity(
  kind: 'authority' | 'company' | 'contract' | 'official',
  id: string,
): string {
  if (kind === 'authority') return `/authorities/${authoritySlug(id)}`;
  if (kind === 'company') return `/companies/${companySlug(id)}`;
  if (kind === 'official') return `/conflicts/official/${personSlug(id)}`;
  return `/contracts/${contractSlug(id)}`;
}
