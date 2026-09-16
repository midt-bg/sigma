import { describe, expect, it } from 'vitest';
import {
  authorityIdFromSlug,
  authoritySlug,
  bareContractId,
  bidderIdFromSlug,
  companySlug,
  contractIdFromSlug,
  contractSlug,
  hrefForEntity,
  maskedCompanySlug,
  personIdFromSlug,
  personSlug,
} from './identity';

describe('company slug', () => {
  it('uses the bare ЕИК for valid bidders (clean, shareable)', () => {
    expect(companySlug('eik:103267194')).toBe('103267194');
    expect(bidderIdFromSlug('103267194')).toBe('eik:103267194');
  });
  it('reversibly encodes name-keyed bidders (incl. Cyrillic, no collisions)', () => {
    const id = 'name:МЕДЕКС ООД; АЛТА ФАРМАСЮТИКЪЛС ООД';
    const slug = companySlug(id);
    expect(slug.startsWith('n')).toBe(true);
    expect(slug).not.toContain(' ');
    expect(bidderIdFromSlug(slug)).toBe(id);
  });
  it('round-trips a 13-digit ЕИК', () => {
    expect(bidderIdFromSlug(companySlug('eik:8316417910124'))).toBe('eik:8316417910124');
  });
  it('resolves the unknown bidder linked from contract pages', () => {
    expect(companySlug('unknown:анонимен')).toBe('unknown:анонимен');
    expect(bidderIdFromSlug('unknown:анонимен')).toBe('unknown:анонимен');
  });
});

describe('authority / contract slugs', () => {
  it('round-trips authority ЕИК', () => {
    expect(authoritySlug('auth:000695089')).toBe('000695089');
    expect(authorityIdFromSlug('000695089')).toBe('auth:000695089');
  });
  it('round-trips contract rowid', () => {
    expect(contractSlug('c:52')).toBe('52');
    expect(contractIdFromSlug('52')).toBe('c:52');
  });
  it('round-trips normalized EOP/OCDS contract ids (no "/" in id)', () => {
    const eopId = 'c:e:UNP-1:CONTRACT-1:2026-06-13';
    const ocdsId = 'c:o:UNP-1:CONTRACT-1:2026-06-13';

    expect(contractIdFromSlug(contractSlug(eopId))).toBe(eopId);
    expect(contractIdFromSlug(contractSlug(ocdsId))).toBe(ocdsId);
  });
  it('bareContractId strips the c: prefix without URL-encoding (CSV/export form)', () => {
    // Raw form keeps "/" and "%" literal — contractSlug layers encoding on top of this.
    expect(bareContractId('c:e:UNP:ОП20-42/22/:5:eik:102130456:1')).toBe(
      'e:UNP:ОП20-42/22/:5:eik:102130456:1',
    );
    expect(bareContractId('c:52')).toBe('52');
    // No leading c: → returned unchanged.
    expect(bareContractId('52')).toBe('52');
    // contractSlug builds on bareContractId, encoding only the path-unsafe chars ("/" here).
    const id = 'c:e:UNP:ОП20-42/22/:5:eik:102130456:1';
    expect(contractSlug(id)).toBe(bareContractId(id).replace(/\//g, '%2F'));
  });
  it('percent-encodes path-unsafe chars so the URL segment is always valid', () => {
    // "/" splits the route into multiple segments → 404 without encoding.
    const id = 'c:e:00797-2020-0039:93-ОП20-42/22/:5:eik:102130456:1';
    const slug = contractSlug(id);
    expect(slug).not.toContain('/');
    expect(slug).toContain('%2F');
    // The reading side: React Router decodes params.id before contractIdFromSlug sees it.
    expect(contractIdFromSlug(decodeURIComponent(slug))).toBe(id);

    // Bare "%" must not produce a malformed percent sequence → URIError in React Router.
    const idWithPercent = 'c:e:UNP:50%ADVANCE:_:eik:123456789:1';
    const slugWithPercent = contractSlug(idWithPercent);
    expect(slugWithPercent).toContain('%25');
    expect(() => decodeURIComponent(slugWithPercent)).not.toThrow();
    expect(contractIdFromSlug(decodeURIComponent(slugWithPercent))).toBe(idWithPercent);

    // "?" and "#" are structural URL separators; encode them too.
    const idWithSpecial = 'c:e:UNP:CONTRACT?v=2#note:_:eik:123456789:1';
    const slugWithSpecial = contractSlug(idWithSpecial);
    expect(slugWithSpecial).not.toMatch(/[?#]/);
    expect(() => decodeURIComponent(slugWithSpecial)).not.toThrow();
    expect(contractIdFromSlug(decodeURIComponent(slugWithSpecial))).toBe(idWithSpecial);

    // A space in the id (e.g. a `contract_number` like „ОП 20-42") must be encoded so the SSR href /
    // sitemap <loc> stays a valid URL — a literal space is invalid in <loc> (review #221).
    const idWithSpace = 'c:e:UNP:ОП 20-42:_:eik:123456789:1';
    const slugWithSpace = contractSlug(idWithSpace);
    expect(slugWithSpace).not.toContain(' ');
    expect(slugWithSpace).toContain('%20');
    expect(contractIdFromSlug(decodeURIComponent(slugWithSpace))).toBe(idWithSpace);

    // A backslash must be encoded: the WHATWG URL parser treats `\` as `/` in special-scheme paths,
    // so browsers would split the segment on a raw backslash exactly like on a raw slash — including
    // `..\` traversal shapes normalizing to `../` (review #221).
    const idWithBackslash = 'c:e:UNP:ОП20-42\\22:_:eik:123456789:1';
    const slugWithBackslash = contractSlug(idWithBackslash);
    expect(slugWithBackslash).not.toContain('\\');
    expect(slugWithBackslash).toContain('%5C');
    expect(contractIdFromSlug(decodeURIComponent(slugWithBackslash))).toBe(idWithBackslash);

    // C0 control chars (U+0000–U+001F) and DEL (U+007F) must be encoded too, so an exotic id can never
    // leave a raw control byte in the SSR href / sitemap <loc> (review #221). Built via fromCharCode so
    // no literal control byte lives in this source file.
    const idWithCtrl = `c:e:UNP:${String.fromCharCode(1)}X${String.fromCharCode(0x7f)}:_:eik:123456789:1`;
    const slugWithCtrl = contractSlug(idWithCtrl);
    expect(slugWithCtrl).toContain('%01');
    expect(slugWithCtrl).toContain('%7F');
    expect(contractIdFromSlug(decodeURIComponent(slugWithCtrl))).toBe(idWithCtrl);
  });
});

describe('person slug (свързани лица)', () => {
  it('reversibly encodes a person id (Cyrillic name key, URL-safe)', () => {
    const id = 'person:ИВАН ПЕТРОВ ГЕОРГИЕВ';
    const slug = personSlug(id);
    expect(slug).not.toContain(' ');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('+');
    expect(personIdFromSlug(slug)).toBe(id);
  });
  it('round-trips a key that itself contains a pipe (never split-parsed)', () => {
    // person_id feeds link_key as `person_id|eik`; the slug must not depend on that separator.
    const id = 'person:ФИРМА | ЕООД';
    expect(personIdFromSlug(personSlug(id))).toBe(id);
  });
  it('returns null for an undecodable slug rather than throwing', () => {
    expect(personIdFromSlug('!!!not base64!!!')).toBeNull();
  });
  it('encodes a bare name key the same as its prefixed form (the prefix is stripped, not required)', () => {
    // Callers hand it either shape — a row's person_id carries the prefix, a freshly computed name key
    // does not. Encoding the literal 'person:' into one of them would mint two different URLs for the
    // same human, and only one of them would round-trip.
    expect(personSlug('ИВАН ПЕТРОВ')).toBe(personSlug('person:ИВАН ПЕТРОВ'));
    // Decoding always canonicalises to the prefixed id, so both inputs land on the same person.
    expect(personIdFromSlug(personSlug('ИВАН ПЕТРОВ'))).toBe('person:ИВАН ПЕТРОВ');
  });
});

describe('masked company slug (PR #183 review — lyubomir-bozhinov 2026-09-02, thread on rows.ts:86)', () => {
  // Opaque slug for masked sole-trader / natural-person rows on /companies + /companies.data +
  // home top-10. Unlike `companySlug`, it does NOT round-trip — masked rows are not linkable from
  // the leaderboard by design (their masked profile is reachable only via direct URL or from the
  // contract page, both of which are noindexed). The `m` prefix distinguishes it from `n`
  // (name-keyed, round-trippable) and from bare ЕИК digits; bidderIdFromSlug returns null for it.
  it('prefixes opaque tokens with `m` so they cannot collide with name-keyed (`n`) or ЕИК slugs', () => {
    expect(maskedCompanySlug('eik:121817309').startsWith('m')).toBe(true);
    expect(maskedCompanySlug('eik:121817309')).not.toBe(companySlug('eik:121817309'));
  });
  it('does NOT decode to a bidder id via bidderIdFromSlug (one-way, by design)', () => {
    const slug = maskedCompanySlug('eik:121817309');
    expect(bidderIdFromSlug(slug)).toBeNull();
  });
  it('does NOT contain the bare ЕИК digits', () => {
    const slug = maskedCompanySlug('eik:121817309');
    expect(slug).not.toContain('121817309');
    expect(slug).not.toMatch(/^\d{9}(\d{4})?$/);
  });
  it('is stable — same bidder id yields the same opaque token', () => {
    const a = maskedCompanySlug('eik:121817309');
    const b = maskedCompanySlug('eik:121817309');
    expect(a).toBe(b);
  });
  it('is unique per bidder id', () => {
    const a = maskedCompanySlug('eik:121817309');
    const b = maskedCompanySlug('eik:999999999');
    expect(a).not.toBe(b);
  });
  it('handles name-keyed bidder ids the same way (no key/name leaks in the slug)', () => {
    const slug = maskedCompanySlug('name:НИКОЛАЙ КИРОВ');
    expect(bidderIdFromSlug(slug)).toBeNull();
    expect(slug).not.toContain('НИКОЛАЙ');
    expect(slug).not.toContain('КИРОВ');
  });
  // PR #344 review (ydimitrof 2026-09-03, thread on identity.ts:41) — the previous
  // implementation was `'m' + b64urlEncode(bidderId)` — a trivial base64url reversal recovers
  // `eik:<ЕИК>` (or `name:<name>`) straight out of the slug, defeating the masking. The slug must
  // be a one-way hash, not an encoding. This test pins the property that base64url-decoding the
  // tail does NOT yield the bidder id (or any string that round-trips via bidderIdFromSlug).
  it('is NOT base64url-decodable back to the bidder id (one-way, not encoding)', () => {
    const id = 'eik:121817309';
    const slug = maskedCompanySlug(id);
    // Tail after the `m` prefix MUST not be valid base64url that decodes to the bidder id.
    const tail = slug.slice(1);
    let decoded: string | null = null;
    try {
      const bin = Buffer.from(tail, 'base64url').toString('utf8');
      // Only treat it as a leak if base64url-decoding succeeded and produced something resembling
      // the bidder id; the strict property is that the slug does NOT encode the bidder id.
      decoded = bin;
    } catch {
      // base64url decode failure is fine — that already proves non-reversibility.
    }
    expect(decoded === id).toBe(false);
    // And bidderIdFromSlug returns null for it (no branch in bidderIdFromSlug matches `m…`).
    expect(bidderIdFromSlug(slug)).toBeNull();
  });
  it('a one-way hash is robust to substring-grep heuristics (no ЕИК digit substring in the tail)', () => {
    // Belt-and-braces against the previous broken implementation, which produced
    // `mZWlrOjEyMTgxNzMwOQ` — grep for the ЕИК digits would miss it, but base64url-decode
    // trivially recovers the original. The fix guarantees the tail cannot be reversed at all.
    const slug = maskedCompanySlug('eik:121817309');
    // tail after the `m` prefix must not contain the digit substring.
    expect(slug.slice(1)).not.toContain('121817309');
    // and the tail is not a base64url-recoverable substring that round-trips to the bidder id
    // (the explicit base64url test above is the canonical check).
  });
});

describe('hrefForEntity', () => {
  it('maps a raw domain id (FTS ref) to its route', () => {
    expect(hrefForEntity('authority', 'auth:000695089')).toBe('/authorities/000695089');
    expect(hrefForEntity('company', 'eik:103267194')).toBe('/companies/103267194');
    expect(hrefForEntity('contract', 'c:52')).toBe('/contracts/52');
  });
  it('produces a URL-safe href for contract ids containing "/"', () => {
    const href = hrefForEntity('contract', 'c:e:UNP:ОП20-42/22/');
    expect(href).not.toContain('/contracts/e:UNP:ОП20-42/22/');
    expect(href).toBe('/contracts/e:UNP:ОП20-42%2F22%2F');
  });
});

describe('slug decode edge cases', () => {
  it('authoritySlug returns an unprefixed id verbatim (no auth: prefix)', () => {
    expect(authoritySlug('000695089')).toBe('000695089');
  });
  it('companySlug returns an unprefixed id verbatim (neither eik: nor name:)', () => {
    expect(companySlug('rawid-123')).toBe('rawid-123');
  });
  it('bidderIdFromSlug returns null for an undecodable name slug', () => {
    // starts with 'n' but the remainder is not valid base64url → atob throws → caught → null
    expect(bidderIdFromSlug('n@@@')).toBeNull();
  });
  it('bidderIdFromSlug returns null for a slug that is neither a ЕИК nor name-encoded', () => {
    expect(bidderIdFromSlug('xyz')).toBeNull();
  });
});
