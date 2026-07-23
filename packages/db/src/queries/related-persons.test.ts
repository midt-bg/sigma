import { describe, expect, it } from 'vitest';
import {
  getCompanyConflicts,
  getConflictLeaderboard,
  getLinkContracts,
  getOfficialConflicts,
} from './related-persons';
import { personSlug } from './identity';

// Unit coverage for the TS logic the SQL can't exercise: row→DTO mapping (booleans, own-institution
// truth only on 'exact', declared-year passthrough, URL-safe slug) and null-on-empty. The SQL itself
// (private-ownership filter, ordering, provenance subquery) is covered against a real SQLite in
// ../related-persons-sql.test.ts.

function row(over: Record<string, unknown> = {}) {
  return {
    link_key: 'p1|111',
    person_id: 'person:ИВАН МИНЕВ',
    official: 'Иван Минев',
    company: 'ТРЕЙС ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: 1,
    own_institution: 'exact',
    first_declared_year: '2019',
    last_declared_year: '2023',
    match_method: 'exact_name_key',
    contract_count: 35,
    contract_value_eur: 88_000_000,
    contemporaneous_contract_count: 20,
    contemporaneous_value_eur: 40_000_000,
    first_contract_year: '2021',
    last_contract_year: '2024',
    source_url: 'https://register.cacbg.bg/2024/i.xml',
    ...over,
  };
}

// Minimal D1 stand-in: all() returns the rows registered for the FIRST bound value (the scope key).
function fakeDb(byKey: Record<string, unknown[]>): D1Database {
  return {
    prepare() {
      let key = '';
      return {
        bind(...p: unknown[]) {
          key = String(p[0]);
          return this;
        },
        async all() {
          return { results: byKey[key] ?? [] };
        },
        async first() {
          return null;
        },
      };
    },
  } as unknown as D1Database;
}

describe('related-persons queries', () => {
  it('leaderboard maps rows to dated ownership links (private-ownership only)', async () => {
    const db = fakeDb({ '10': [row()] }); // leaderboard binds only the limit
    const links = await getConflictLeaderboard(db, 10);
    expect(links.map((l) => l.linkKey)).toEqual(['p1|111']);
    // mapping: 1/0 → booleans; ownInstitution true ONLY on the deterministic 'exact' verdict
    expect(links[0]!.ownInstitution).toBe(true);
    expect(links[0]!.contemporaneous).toBe(true);
    expect(links[0]!.contractValueEur).toBe(88_000_000);
    // the conflict-window split carries through as its own count + value
    expect(links[0]!.contemporaneousContractCount).toBe(20);
    expect(links[0]!.contemporaneousValueEur).toBe(40_000_000);
    // declared span carries through; the surface dates every link
    expect(links[0]!.firstDeclaredYear).toBe('2019');
    expect(links[0]!.lastDeclaredYear).toBe('2023');
    // person_id is encoded to a URL-safe slug, never surfaced raw
    expect(links[0]!.officialSlug).toBe(personSlug('person:ИВАН МИНЕВ'));
    expect(links[0]!.officialSlug).not.toContain(' ');
  });

  it('own-institution is false for every non-exact verdict', async () => {
    for (const verdict of ['name_contains', 'locality', 'none']) {
      const db = fakeDb({ '10': [row({ own_institution: verdict })] });
      const links = await getConflictLeaderboard(db, 10);
      expect(links[0]!.ownInstitution).toBe(false);
    }
  });

  it('official conflicts return the office-holder + their links, null when none', async () => {
    const db = fakeDb({
      'person:ivan': [row({ link_key: 'a' }), row({ link_key: 'b' })],
    });
    const res = await getOfficialConflicts(db, 'person:ivan');
    expect(res?.official).toBe('Иван Минев');
    expect(res?.links.map((l) => l.linkKey)).toEqual(['a', 'b']);
    expect(await getOfficialConflicts(fakeDb({}), 'person:none')).toBeNull();
  });

  it('company conflicts return the officials, and null when none', async () => {
    const db = fakeDb({ '111': [row(), row({ link_key: 'p2|111', official: 'Друг' })] });
    const res = await getCompanyConflicts(db, '111');
    expect(res?.eik).toBe('111');
    expect(res?.company).toBe('ТРЕЙС ГРУП ХОЛД АД');
    expect(res?.links).toHaveLength(2);
    expect(await getCompanyConflicts(fakeDb({}), '999')).toBeNull();
  });

  it('link contracts map the raw id to a URL slug and pass the temporal mark through', async () => {
    const db = fakeDb({
      'person:ivan|111': [
        {
          id: 'c:e:abc',
          signed_at: '2021-05-01',
          authority: 'Община Пловдив',
          contract_kind: 'Услуги',
          contract_number: 'Д-1',
          amount_eur: 1_000_000,
          temporal: 'contemporaneous',
        },
      ],
    });
    const contracts = await getLinkContracts(db, 'person:ivan|111');
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.contractSlug).toBe('e:abc'); // 'c:' prefix stripped → /contracts/:id segment
    expect(contracts[0]!.temporal).toBe('contemporaneous');
    expect(contracts[0]!.authority).toBe('Община Пловдив');
    // an unknown/non-surfaced link_key yields no contracts (the SQL WHERE gate returns nothing)
    expect(await getLinkContracts(fakeDb({}), 'person:nobody|000')).toEqual([]);
  });
});
