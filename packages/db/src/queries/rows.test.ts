import { describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
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
