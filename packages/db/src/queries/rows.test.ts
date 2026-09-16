import { describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
import { bidderIdFromSlug } from './identity';
import { toAuthorityListItem, toCompanyListItem, typeLabel } from './rows';

describe('typeLabel', () => {
  it('returns the display label for a known type group', () => {
    expect(typeLabel('министерство')).toBe('министерство');
    expect(typeLabel('община')).toBe('община');
    expect(typeLabel('държавна компания')).toBe('държ. компания');
  });

  it('returns the input unchanged for an unknown type group', () => {
    expect(typeLabel('неизвестен тип')).toBe('неизвестен тип');
  });

  it('returns null for null input', () => {
    expect(typeLabel(null)).toBeNull();
  });
});

describe('toCompanyListItem', () => {
  const base = {
    bidder_id: 'eik:103267194',
    name: 'ТЕСТ ООД',
    kind: 'company' as const,
    ownership_kind: null,
    eik: '103267194',
    eik_valid: 1,
    settlement: 'София',
    won_eur: 50000,
    contracts: 5,
    authorities: 2,
    primary_sector: '45',
    eu_eur: 10000,
    first_date: '2022-01-01',
    last_date: '2024-06-01',
    legal_form: 'ООД',
  };

  it('maps core fields', () => {
    const item = toCompanyListItem(base);
    expect(item.slug).toBe('103267194');
    expect(item.name).toBe('ТЕСТ ООД');
    expect(item.kind).toBe('company');
    expect(item.wonEur).toBe(50000);
    expect(item.contracts).toBe(5);
    expect(item.authorities).toBe(2);
    expect(item.settlement).toBe('София');
  });

  it('sets hasEik true when eik_valid=1 and eik is set', () => {
    expect(toCompanyListItem(base).hasEik).toBe(true);
  });

  it('sets hasEik false when eik_valid=0', () => {
    expect(toCompanyListItem({ ...base, eik_valid: 0 }).hasEik).toBe(false);
  });

  it('sets hasEik false when eik is null', () => {
    expect(toCompanyListItem({ ...base, eik: null }).hasEik).toBe(false);
  });

  it('sets isConsortium true for consortium kind', () => {
    expect(toCompanyListItem({ ...base, kind: 'consortium' }).isConsortium).toBe(true);
  });

  it('sets isConsortium false for company kind', () => {
    expect(toCompanyListItem(base).isConsortium).toBe(false);
  });

  it('resolves the sector ref when primary_sector is a valid CPV division', () => {
    const item = toCompanyListItem(base);
    expect(item.sector).not.toBeNull();
    expect(item.sector?.code).toBe('45');
  });

  it('sets sector to null when primary_sector is null', () => {
    expect(toCompanyListItem({ ...base, primary_sector: null }).sector).toBeNull();
  });
});

describe('toCompanyListItem — privacy masking on the leaderboard list (PR #183 review #1)', () => {
  // /companies and /companies.data and the home top-10 all share this mapper. Mask ЕИК + name on
  // the natural-person branch so a sole trader's ЕИК does not leak through the leaderboard list
  // payload (HTML + RRv7 single-fetch .data twin). The CSV streamer already masks the same row
  // upstream of bytes hitting R2 (companies.ts); the JSON masker for /contracts/:id.json masks
  // maskContractForPrivacy; this closes the third surface. Consortium guard is required by
  // isNaturalPersonBidder's docstring (caller filters JVs).
  const baseRow = {
    bidder_id: 'eik:121817309',
    kind: 'company' as const,
    ownership_kind: null,
    eik: '121817309',
    eik_valid: 1,
    settlement: 'София',
    won_eur: 50000,
    contracts: 5,
    authorities: 2,
    primary_sector: '45',
    eu_eur: 0,
    first_date: '2022-01-01',
    last_date: '2024-06-01',
  };

  it('masks ЕИК and name for a sole trader with legal_form=ЕТ', () => {
    const item = toCompanyListItem({
      ...baseRow,
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      legal_form: 'ЕТ',
    });
    expect(item.eik).toBeNull();
    expect(item.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(item.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(item.hasEik).toBe(false);
  });

  it('keeps the masking signal consistent across eik / eikValid / hasEik / masked (ydimitrof review 2026-08-31, threads #2 + #7)', () => {
    // Thread on rows.ts:80: for a masked row the rollup bit `eik_valid === 1` must follow `hasEik`
    // — a consumer that sees `eik: null, hasEik: false, eikValid: true` would render a „валиден
    // ЕИК" badge next to an empty value. The mapper is the single source of truth and must
    // produce a payload that is self-consistent for any masked row.
    //
    // Thread on rows.ts:74 + apps/web/app/routes/companies.tsx:84: the mapper exposes a `masked`
    // boolean alongside the masking label so consumers can branch on a flag instead of
    // string-comparing the label. The flag is set ONLY on the natural-person branch (and never
    // on legal-entity or consortium branches, which are not masked).
    const natural = toCompanyListItem({
      ...baseRow,
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      legal_form: 'ЕТ',
    });
    expect(natural.masked).toBe(true);
    expect(natural.eik).toBeNull();
    expect(natural.eikValid).toBe(false);
    expect(natural.hasEik).toBe(false);

    // The `eikValid: false` change must NOT regress the legal-entity branch: a legal entity with
    // a valid ЕИК keeps `eikValid: true` and `masked: false`.
    const legal = toCompanyListItem({
      ...baseRow,
      name: 'СТРОЙ ООД',
      legal_form: 'ООД',
    });
    expect(legal.masked).toBe(false);
    expect(legal.eik).toBe('121817309');
    expect(legal.eikValid).toBe(true);
    expect(legal.hasEik).toBe(true);

    // The consortium branch is NOT masked either — `masked` stays false even when the name starts
    // with "ЕТ " (mirrors the `kind !== 'consortium'` guard on the natural-person branch).
    const consortium = toCompanyListItem({
      ...baseRow,
      kind: 'consortium',
      name: 'ЕТ Иван Петров; Строй ООД',
      legal_form: null,
      eik: '200000000',
    });
    expect(consortium.masked).toBe(false);
    expect(consortium.eik).toBe('200000000');
    expect(consortium.eikValid).toBe(true);
  });

  it('masks on the leading-ЕТ name heuristic when legal_form is null', () => {
    // Same pattern CSV streamer guards with: a row whose name starts with "ЕТ " but lacks a
    // legal_form value still trips the predicate.
    const item = toCompanyListItem({
      ...baseRow,
      name: 'ЕТ Иван Петров',
      legal_form: null,
    });
    expect(item.eik).toBeNull();
    expect(item.name).toBe(MASKED_NATURAL_PERSON_LABEL);
  });

  it('preserves ЕИК + name verbatim for a legal entity (ООД)', () => {
    const item = toCompanyListItem({
      ...baseRow,
      name: 'СТРОЙ ООД',
      legal_form: 'ООД',
    });
    expect(item.eik).toBe('121817309');
    expect(item.name).toBe('СТРОЙ ООД');
    expect(item.displayName).toBe('СТРОЙ ООД');
    expect(item.hasEik).toBe(true);
  });

  it('does NOT mask a consortium whose first member is a sole trader (MAJOR-class guard)', () => {
    // Mirrors the CSV streamer guard: a JV like "ЕТ Иван Петров; Строй ООД" must keep its
    // consortium name + ЕИК. Failing this is a regression to the pre-`bidder_kind !== 'consortium'`
    // guard bug class.
    const item = toCompanyListItem({
      ...baseRow,
      kind: 'consortium',
      name: 'ЕТ Иван Петров; Строй ООД',
      legal_form: null,
      eik: '200000000',
    });
    expect(item.eik).toBe('200000000');
    expect(item.name).toBe('ЕТ Иван Петров; Строй ООД');
    expect(item.isConsortium).toBe(true);
  });

  it('replaces the masked slug with an opaque, non-ЕИК token (lyubomir-bozhinov review 2026-09-02, thread on rows.ts:86)', () => {
    // The slug for an eik:-keyed sole trader used to fall through `companySlug` verbatim — i.e. the
    // bare ЕИК — and was serialised on /companies.data (RRv7 single-fetch turbo-stream, machine-readable
    // twin of the leaderboard) and on the HTML hydration payload of the public indexable leaderboard.
    // `masked` rows are rendered as a non-link <span> in companies.tsx already, but the slug itself
    // still leaked the ЕИК to crawlers reading the JSON payload (the rendered HTML and the .data twin
    // share the same loader, so the slug is in both responses). The mapper must produce a slug that:
    //   (a) does NOT decode to a valid bidder_id via bidderIdFromSlug (the slug is opaque, not
    //       URL-resolvable — masked rows are not linkable from the leaderboard by design);
    //   (b) is stable across rebuilds (depends only on the bidder id, so the same masked row on a
    //       later page or a different sort produces the same opaque token — required for the
    //       React `key` prop on DataTable rows in companies.tsx:249);
    //   (c) does NOT contain the ЕИК digits verbatim (a consumer that greps the response for
    //       \\d{9,13} would otherwise still find the masked row's identifier).
    const natural = toCompanyListItem({
      ...baseRow,
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      legal_form: 'ЕТ',
    });
    expect(natural.masked).toBe(true);
    // (a) opaque — does not round-trip to the original bidder id.
    expect(bidderIdFromSlug(natural.slug)).toBeNull();
    // (c) does not contain the ЕИК digits in any form.
    expect(natural.slug).not.toContain('121817309');
    expect(natural.slug).not.toMatch(/^\d{9}(\d{4})?$/);
    // Stability: the same bidder id always yields the same opaque slug, regardless of the mask
    // branch's other inputs.
    const sameRow = toCompanyListItem({
      ...baseRow,
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      legal_form: 'ЕТ',
    });
    expect(sameRow.slug).toBe(natural.slug);

    // The legal-entity branch is untouched — its slug is still the bare ЕИК (round-trippable).
    const legal = toCompanyListItem({
      ...baseRow,
      name: 'СТРОЙ ООД',
      legal_form: 'ООД',
    });
    expect(legal.masked).toBe(false);
    expect(legal.slug).toBe('121817309');
    expect(bidderIdFromSlug(legal.slug)).toBe('eik:121817309');

    // The consortium branch is also untouched.
    const consortium = toCompanyListItem({
      ...baseRow,
      bidder_id: 'eik:200000000',
      kind: 'consortium',
      name: 'ЕТ Иван Петров; Строй ООД',
      legal_form: null,
      eik: '200000000',
    });
    expect(consortium.masked).toBe(false);
    expect(consortium.slug).toBe('200000000');
    expect(bidderIdFromSlug(consortium.slug)).toBe('eik:200000000');
  });
});

describe('toAuthorityListItem', () => {
  const base = {
    authority_id: 'auth:000695089',
    name: 'Министерство на финансите',
    type_group: 'министерство' as const,
    settlement: 'София',
    region: 'Столична',
    spent_eur: 1000000,
    contracts: 100,
    suppliers: 30,
    avg_eur: 10000,
    primary_sector: '45',
    eu_eur: 200000,
    first_date: '2020-01-01',
    last_date: '2024-12-31',
  };

  it('maps core fields', () => {
    const item = toAuthorityListItem(base);
    expect(item.slug).toBe('000695089');
    expect(item.name).toBe('Министерство на финансите');
    expect(item.typeGroup).toBe('министерство');
    expect(item.typeLabel).toBe('министерство');
    expect(item.settlement).toBe('София');
    expect(item.spentEur).toBe(1000000);
    expect(item.contracts).toBe(100);
    expect(item.avgEur).toBe(10000);
  });

  it('resolves typeLabel for unknown type groups', () => {
    const item = toAuthorityListItem({ ...base, type_group: 'неизвестен' });
    expect(item.typeLabel).toBe('неизвестен');
  });

  it('sets typeLabel to null when type_group is null', () => {
    const item = toAuthorityListItem({ ...base, type_group: null });
    expect(item.typeGroup).toBeNull();
    expect(item.typeLabel).toBeNull();
  });
});
