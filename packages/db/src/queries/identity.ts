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

/** bidder id → `/companies/:slug` segment. Valid ЕИК → digits; name-keyed → `n` + base64url(name);
 * the labelled unknown bucket stays literal so contract-page links remain resolvable. */
export function companySlug(bidderId: string): string {
  if (bidderId.startsWith('eik:')) return bidderId.slice(4);
  if (bidderId.startsWith('name:')) return 'n' + b64urlEncode(bidderId.slice(5));
  return bidderId;
}

/** bidder id → opaque `/companies/:slug` segment for masked natural-person / sole-trader rows on
 * the leaderboard list and home top-10. Unlike `companySlug`, this is a one-way token: it does
 * NOT round-trip to a `bidder_id` via `bidderIdFromSlug` — masked rows are not linkable from the
 * public leaderboard by design (their masked profile is reachable only via direct URL or from a
 * noindexed contract page). The `m` prefix distinguishes it from `n` (name-keyed, round-trippable)
 * and from bare ЕИК digits so `bidderIdFromSlug` returns null. Stable across rebuilds (depends only
 * on the bidder id, which is the only stable input on a masked row — the name is masked, the ЕИК
 * is nulled).
 *
 * Implementation: 64-bit FNV-1a hash, hex-encoded. FNV-1a is non-invertible by design — there is
 * no `decode` that recovers the bidder id from the hash. Used here (not SHA-256) because the
 * surrounding `companySlug` / `bidderIdFromSlug` helpers are synchronous and dependency-free; the
 * web worker bundle does NOT enable `nodejs_compat`, so `node:crypto` is unavailable, and Web
 * Crypto's `crypto.subtle.digest` is async. The list/leaderboard pipeline (`toCompanyListItem` in
 * rows.ts) calls this for every row inside a synchronous mapper. FNV-1a-64 has a 64-bit collision
 * space — birthday paradox gives ~50% collision at ~4 billion distinct bidders, well above the
 * realistic pool size — and is the standard "small opaque token" hash used for the same purpose
 * in many places (e.g. Sentry's `hashCode`, Java's `HashMap` seed). The 16-hex-char output is
 * stable across rebuilds (depends only on `bidderId`), URL-safe (lowercase hex), and unrecoverable
 * — the threat model is a scraper running `atob(slug.slice(1))` against the public JSON payload
 * (FNV-1a has no such shortcut), not a cryptographic adversary. lyubomir-bozhinov review
 * 2026-09-04, thread on packages/db/src/queries/identity.ts:41 (PR #345) and #183 — the previous
 * implementation was `'m' + b64urlEncode(bidderId)`, which is trivially reversed with
 * `atob(slug.slice(1))` and recovers the bare ЕИК; this fix closes that hole.
 *
 * BigInt is used to hold the 64-bit state (JS numbers only have 53 safe bits). FNV-1a-64 is
 * well-known to be reproducible byte-for-byte across JS engines (V8, JSC, SpiderMonkey) — there
 * are no BigInt arithmetic ambiguity points (we always mask back to 64 bits after the multiply,
 * matching the reference C implementation in glib / the FNV reference implementation). */
function fnv1a64Hex(s: string): string {
  // FNV-1a 64-bit offset basis + prime (reference values from isthe.com/chongo/tech/comp/fnv/).
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  // 16 hex chars, lowercase, zero-padded. Stable + URL-safe.
  return h.toString(16).padStart(16, '0');
}

export function maskedCompanySlug(bidderId: string): string {
  return 'm' + fnv1a64Hex(bidderId);
}

/** `/companies/:slug` segment → bidder id, or null if it cannot be decoded. */
export function bidderIdFromSlug(slug: string): string | null {
  if (EIK_RE.test(slug)) return 'eik:' + slug;
  if (slug === 'unknown:анонимен') return slug;
  if (slug.startsWith('n')) {
    try {
      return 'name:' + b64urlDecode(slug.slice(1));
    } catch {
      return null;
    }
  }
  return null;
}

/** person id (`person:<name-key>|<institution-key>`) → `/conflicts/official/:slug` segment. The id encodes
 *  the (name, institution) grain (ADR-0026; `personId()` in load.mjs) — NOT name alone — so two namesakes in
 *  different institutions get DISTINCT slugs and never collapse into one page/row. The key is uppercase
 *  Cyrillic with spaces (companyNameKey output) — not URL-clean — so base64url the WHOLE id (name+institution),
 *  like a name-keyed bidder. Stable across rebuilds (depends only on the normalised name+institution); encodes
 *  the id wholesale and never split-parses the internal `|`, nor the extra `|`s that link_key layers on. */
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

/** contract id (`c:*`) → bare id without the leading `c:` prefix. This is the raw, un-encoded form
 *  — suitable for data export (CSV) where URL escaping is undesirable. Slug/href callers must layer
 *  `contractSlug` on top for path safety. */
export function bareContractId(contractId: string): string {
  return contractId.startsWith('c:') ? contractId.slice(2) : contractId;
}

/** contract id (`c:*`) → `/contracts/:id` segment (the id without the leading `c:`). Path-unsafe
 *  characters are percent-encoded: `%` first (to avoid mangling later replacements), then the URL
 *  structural chars `/`, `?`, `#`, and `\` — the WHATWG URL parser treats `\` as `/` in special-scheme
 *  paths, so an unencoded backslash would split the segment exactly like a raw slash (review #221) —
 *  plus whitespace and every Unicode control char via the `\p{Cc}`
 *  property (C0 U+0000–U+001F, DEL U+007F, C1 U+0080–U+009F). Encoding whitespace keeps the SSR-emitted
 *  href / sitemap `<loc>` a technically-valid URL when a domain id carries a space — e.g. a
 *  `contract_number` like `ОП 20-42` (review #221; a literal space in `<loc>` violates the sitemap spec).
 *  `\p{Cc}` is used rather than a raw code-point range so the class can't be misread as caret notation
 *  (`^@-^_`) in a diff viewer. Readable chars (incl. Cyrillic) and the structural `:` separators stay
 *  literal. React Router decodes these back in params, so `contractIdFromSlug` needs no change.
 *  The output is URL-path-safe but NOT HTML/XML-safe (`"` `<` `>` `'` `&` stay literal) — every
 *  consumer embedding it in markup must escape it (React JSX does; sitemaps use `xmlEscape`). */
export function contractSlug(contractId: string): string {
  return bareContractId(contractId)
    .replace(/%/g, '%25')
    .replace(/[/\\?#\s\p{Cc}]/gu, encodeURIComponent);
}

/** `/contracts/:id` segment → contract id. The segment must already be percent-DECODED — pass React
 *  Router's `params.id` (RR decodes path params); never feed a raw URL segment straight off the wire,
 *  or an encoded `%2F` survives as literal `%2F` text inside the id. */
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
