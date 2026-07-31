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
    institution: 'Община Русе',
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
    // institution carries through — the namesake disambiguator (person grain is (name, institution))
    expect(links[0]!.institution).toBe('Община Русе');
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

// A D1 whose statements throw D1's „no such table" — the свързани-лица migration (0003) not yet applied to
// this env. Every conflict read must degrade (empty/null), never 500.
function throwingDb(err: Error): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all(): Promise<never> {
          throw err;
        },
        async first(): Promise<never> {
          throw err;
        },
      };
    },
  } as unknown as D1Database;
}

describe('conflict reads soft-fail on an un-migrated env (no 500)', () => {
  const missing = () =>
    throwingDb(new Error('D1_ERROR: no such table: interest_links: SQLITE_ERROR'));

  it('leaderboard → [], official/company → null, contracts → []', async () => {
    expect(await getConflictLeaderboard(missing(), 10)).toEqual([]);
    expect(await getOfficialConflicts(missing(), 'person:x')).toBeNull();
    expect(await getCompanyConflicts(missing(), '111')).toBeNull();
    expect(await getLinkContracts(missing(), 'p|1')).toEqual([]);
  });

  it('a NON-missing-table error still propagates — we only swallow the migration gap', async () => {
    const boom = throwingDb(new Error('D1_ERROR: syntax error near "FROM"'));
    await expect(getConflictLeaderboard(boom, 10)).rejects.toThrow(/syntax error/);
    await expect(getOfficialConflicts(boom, 'person:x')).rejects.toThrow(/syntax error/);
    await expect(getCompanyConflicts(boom, '111')).rejects.toThrow(/syntax error/);
    await expect(getLinkContracts(boom, 'p|1')).rejects.toThrow(/syntax error/);
  });

  // B5 (todorkolev #226): the soft-fail must be SPECIFIC to the 0003 tables. A missing CORE table (bidders)
  // is real schema loss and must surface as a 500 — never be masked as „0003 not applied yet" (a silently
  // empty surface would tell no one the env is broken).
  it('a missing CORE table (bidders) propagates — only свързани-лица tables soft-fail', async () => {
    const coreLoss = () => throwingDb(new Error('D1_ERROR: no such table: bidders: SQLITE_ERROR'));
    await expect(getConflictLeaderboard(coreLoss(), 10)).rejects.toThrow(/no such table: bidders/);
    await expect(getOfficialConflicts(coreLoss(), 'person:x')).rejects.toThrow(/bidders/);
    await expect(getCompanyConflicts(coreLoss(), '111')).rejects.toThrow(/bidders/);
    await expect(getLinkContracts(coreLoss(), 'p|1')).rejects.toThrow(/bidders/);
  });

  // Every 0003-owned table name is recognized as the migration gap (soft-fail), so a half-applied 0003 that
  // trips on any of them degrades rather than 500s.
  it('each свързани-лица table missing is treated as the migration gap', async () => {
    for (const t of [
      'interest_links',
      'persons',
      'declarations',
      'declared_interests',
      'interest_link_authorities',
      'related_persons_internal',
    ]) {
      const db = throwingDb(new Error(`D1_ERROR: no such table: ${t}: SQLITE_ERROR`));
      expect(await getConflictLeaderboard(db, 10), t).toEqual([]);
    }
  });
});
