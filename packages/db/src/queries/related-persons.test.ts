import { describe, expect, it } from 'vitest';
import { fakeD1, throwingD1, type FakeD1Call } from '@sigma/test-support';
import {
  EIK_CONTRACTS_SQL,
  LINK_CONTRACTS_SQL,
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
    // SURFACED_OWNERSHIP only returns rows carrying a publishing seal, so the fixture carries one too —
    // a fixture without it would exercise a row shape the SQL cannot produce.
    evidence_kind: 'document',
    registry_role: 'owner',
    entry_number: '20110502101007',
    entry_date: '2011-05-02',
    lookup_date: '2026-08-05',
    ...over,
  };
}

// Minimal D1 stand-in: all() returns the rows registered for the FIRST bound value (the scope key).
// Exposes the shared double's own call log on `.calls` so a test can assert how many reads a load
// issued (e.g. ЕИК dedup) — the log already carries the SQL and the binds this used to project.
function fakeDb(byKey: Record<string, unknown[]>): D1Database & { calls: FakeD1Call[] } {
  // A contract read (by ЕИК or link_key) can bind the SAME value a scope query already used (a company
  // page binds the ЕИК for both COMPANY_SQL and EIK_CONTRACTS_SQL), so contract reads are STRICTLY
  // namespaced under a `contracts:` key — never falling back to the scope rows (which would map link rows
  // as contracts). A scope query with no contract rows registered simply reads an empty contract set.
  const contracts =
    (sql: string) =>
    (call: { sql: string; binds: unknown[] }): unknown[] => {
      // Markers match by substring; the double this replaced dispatched on `sql === EIK_CONTRACTS_SQL`,
      // so the equality it asserted belongs inside the route rather than being widened by the move.
      expect(call.sql).toBe(sql);
      return byKey[`contracts:${String(call.binds[0])}`] ?? [];
    };
  const fake = fakeD1([
    { when: EIK_CONTRACTS_SQL, all: contracts(EIK_CONTRACTS_SQL) },
    { when: LINK_CONTRACTS_SQL, all: contracts(LINK_CONTRACTS_SQL) },
    { when: 'FROM interest_links il', all: (call) => byKey[String(call.binds[0])] ?? [] },
  ]);
  // Object.assign, not a cast: `calls` is the live array the double already keeps, so the handle
  // types as the intersection without anyone having to assert it is a D1Database.
  return Object.assign(fake.db, { calls: fake.calls });
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

  // #287 + niki #312 HIGH 2: the detail loaders batch each link's contracts EAGERLY, but DEDUPED by ЕИК — the
  // read is keyed on the winner's ЕИК (`EIK_CONTRACTS_SQL` binds it first), and `temporal` is derived per link
  // in TS. So a contract set registered under a ЕИК is served to EVERY link on that winner, each marked for its
  // own declared window. A raw contract row here carries NO `temporal` column (it is computed, not selected).
  const eikContract = (over: Record<string, unknown> = {}) => ({
    id: 'c:e:a1',
    signed_at: '2021-05-01', // within the 2019–2023 declared window of row() → 'contemporaneous'
    authority: 'Община Пловдив',
    authority_id: 'auth1',
    authority_total_eur: 5_000_000,
    contract_kind: 'Услуги',
    contract_number: 'Д-1',
    amount_eur: 1_000_000,
    procedure_type: 'открита процедура',
    subject: 'Ремонт',
    ...over,
  });

  it('official conflicts eager-load each WINNER contracts keyed by ЕИК (facts only; temporal is derived client-side)', async () => {
    // Two links on DIFFERENT winners (ЕИК 111, 222) — one read per distinct ЕИК, keyed by ЕИК. The rows are
    // FACTS: no `temporal` column (it is per-link, derived in the component by markContracts).
    const db = fakeDb({
      'person:ivan': [row({ link_key: 'a', eik: '111' }), row({ link_key: 'b', eik: '222' })],
      'contracts:111': [eikContract()],
      'contracts:222': [eikContract({ id: 'c:e:b1', signed_at: '2016-03-01' })],
    });
    const res = await getOfficialConflicts(db, 'person:ivan');
    // keyed by ЕИК (one array per winner), NOT per linkKey
    expect(Object.keys(res!.contracts).sort()).toEqual(['111', '222']);
    expect(res!.contracts['111']).toHaveLength(1);
    expect(res!.contracts['111']![0]!.contractSlug).toBe('e:a1'); // 'c:' prefix stripped
    // facts carry NO temporal — that is a per-link presentation concern, derived by markContracts
    expect('temporal' in res!.contracts['111']![0]!).toBe(false);
  });

  it('company conflicts read the shared ЕИК contracts ONCE, keyed by ЕИК (HIGH 1 payload + HIGH 2 query dedup)', async () => {
    // Two officials on the SAME winner (ЕИК 111). The old code read AND serialised the identical set once PER
    // link (measured 61× on a real company); now the ЕИК is read once and the DTO carries it once, keyed by ЕИК
    // — every official's block derives its own window split from the same shared facts client-side.
    const db = fakeDb({
      '111': [row({ link_key: 'p1|111' }), row({ link_key: 'p2|111', official: 'Друг' })],
      'contracts:111': [eikContract()],
    });
    const res = await getCompanyConflicts(db, '111');
    // ONE contracts entry, keyed by the shared ЕИК — not one array per official (the payload dedup)
    expect(Object.keys(res!.contracts)).toEqual(['111']);
    expect(res!.contracts['111']).toHaveLength(1);
    expect('temporal' in res!.contracts['111']![0]!).toBe(false);
    // …and the ЕИК contract set was READ exactly once, though two links share it
    const eikReads = db.calls.filter(
      (call) => call.sql === EIK_CONTRACTS_SQL && String(call.binds[0]) === '111',
    );
    expect(eikReads).toHaveLength(1);
  });

  it('link contracts map the raw id to a URL slug and pass the temporal mark through', async () => {
    // getLinkContracts (the gated lazy-route read) selects `temporal` in SQL, so the row carries it; contract
    // reads are namespaced under `contracts:<link_key>` in the fake.
    const db = fakeDb({
      'contracts:person:ivan|111': [
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
  return throwingD1(err).db;
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

// The evidence seal is what licenses the card's registry sentence, and the two rungs assert very
// different things: 'document' renders „лицето е вписано като съдружник/собственик" — that the register
// names THIS person in THIS company — while 'confirmed' claims only that the declared data matched.
// The mapper used to read `kind === 'confirmed' ? 'confirmed' : 'document'`, so NULL, 'refuted', a rung
// added later, or a typo all became the STRONGEST claim we can make about a named human being. The SQL
// gate makes that unreachable today; the failure DIRECTION is still wrong, and this is the one place in
// the codebase where being wrong by default is libel rather than a rendering glitch.
describe('an unrecognised evidence seal withholds the link instead of upgrading it', () => {
  for (const kind of ['refuted', 'unknown', 'bar_joint_stock', 'outside_tr', 'future_rung_v9'])
    it(`'${kind}' never renders as a registry claim`, async () => {
      const db = fakeDb({ '10': [row({ evidence_kind: kind })] });
      expect(await getConflictLeaderboard(db, 10)).toEqual([]);
    });

  it('a NULL seal — the half-migrated read the old comment invited — withholds too', async () => {
    const db = fakeDb({ '10': [row({ evidence_kind: null })] });
    expect(await getConflictLeaderboard(db, 10)).toEqual([]);
  });

  it('both publishing rungs still map, and to DIFFERENT kinds — the guard bounds, it does not flatten', async () => {
    for (const kind of ['document', 'confirmed']) {
      const db = fakeDb({ '10': [row({ evidence_kind: kind })] });
      const links = await getConflictLeaderboard(db, 10);
      expect(links).toHaveLength(1);
      expect(links[0]!.evidenceKind).toBe(kind);
    }
  });

  it('the official page 404s rather than render a page under a name with nothing left to show', async () => {
    const db = fakeDb({ 'person:ivan': [row({ evidence_kind: 'refuted' })] });
    expect(await getOfficialConflicts(db, 'person:ivan')).toBeNull();
    expect(
      await getCompanyConflicts(fakeDb({ '111': [row({ evidence_kind: null })] }), '111'),
    ).toBeNull();
  });

  it('one withheld row does not take its sealed siblings down with it', async () => {
    const db = fakeDb({
      '10': [row({ link_key: 'ok|111' }), row({ link_key: 'bad|111', evidence_kind: 'refuted' })],
    });
    expect((await getConflictLeaderboard(db, 10)).map((l) => l.linkKey)).toEqual(['ok|111']);
  });
});
