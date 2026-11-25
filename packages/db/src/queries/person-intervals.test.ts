// The band must agree with the red numbers to the day. This builds a person whose ties and offices have
// every edge the activity CTE knows — a role that ended and one that stands, an uncertain end, a declared
// window with a disputed year, an office with a gap year, an exit filing mid-year, two declarants — signs
// a contract every few days across a decade, and checks each one: red if and only if inside the band.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import {
  getTimelineIntervals,
  institutionPeriod,
  overlapBands,
  type InstitutionOfficeSpan,
  TIMELINE_SUBJECT_CHARS,
  type DaySpan,
} from './person-intervals';

let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function fixture() {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_roles(subject_id,subject_kind,eik,role,added_on,removed_on,uncertain_after);
    CREATE TABLE registry_deeds(eik,outcome,fetched_at);
    CREATE TABLE interest_links(person_id,eik,link_key,status,interest_class,first_declared_year,last_declared_year,relation);
    CREATE TABLE interest_link_evidence(link_key,evidence_kind,matched_fact TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
    CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
    CREATE TABLE person_registry_links(person_id,registry_indent);
    CREATE TABLE bidders(id,name,eik_normalized,ownership_kind);
    CREATE TABLE company_totals(bidder_id,contracts);
    CREATE TABLE tenders(id,title,authority_id,published_at);
    CREATE TABLE authorities(id,name);
    CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
    CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
    CREATE TABLE contracts(id,contract_subject,bidder_id,tender_id,signed_at,amount_eur,bids_received);
    INSERT INTO authorities VALUES('auth:1','Община Тест');
    INSERT INTO bidders(id,name,eik_normalized) VALUES
      ('eik:111111111','Роля ЕООД','111111111'),('eik:222222222','Дял ООД','222222222');
    INSERT INTO company_totals VALUES('eik:111111111',1),('eik:222222222',1);
    INSERT INTO registry_deeds VALUES('111111111','ok','2025-03-10T08:00:00Z');
    -- Роля ЕООД: a role that ended, a gap, a role that stands (observed by the last read), and a second
    -- standing role that became uncertain.
    INSERT INTO registry_roles VALUES
      ('person','person','111111111','manager','2018-03-15','2019-06-30',NULL),
      ('person','person','111111111','partner','2020-02-01',NULL,NULL),
      ('person','person','111111111','manager','2021-01-01',NULL,'2022-05-01');
    -- Дял ООД: a declared stake 2017–2023, with 2021 disputed by an omission in a comparable filing.
    INSERT INTO interest_links VALUES
      ('official','222222222','l','published','private_ownership','2017','2023','owns');
    INSERT INTO interest_link_evidence VALUES('l','document');
    INSERT INTO interest_link_observations VALUES('l','d-omit','shares','not_listed','2021');
    -- The office: 2017–2019 and 2021–2024 for one declarant (2020 has no filing), an exit filed in
    -- 2024; a second declarant of the same person files for 2016 only.
    INSERT INTO declarations VALUES
      ('o17','official','Община Тест','Съветник','2017'),('o18','official','Община Тест','Съветник','2018'),
      ('o19','official','Община Тест','Съветник','2019'),('o21','official','Община Тест','Съветник','2021'),
      ('o22','official','Община Тест','Съветник','2022'),('o24','official','Община Тест','Съветник','2024'),
      ('a16','alias','Друго ведомство','Директор','2016');
    INSERT INTO declaration_metadata VALUES
      ('o17','entry','2017-04-20',NULL),('o24','vacate','2024-08-12',NULL);`);
  const tender = db!.prepare("INSERT INTO tenders VALUES(?, 'Предмет', 'auth:1', ?)");
  const contract = db!.prepare('INSERT INTO contracts VALUES(?, ?, ?, ?, ?, 100, ?)');
  let n = 0;
  for (let day = Date.UTC(2015, 0, 1); day <= Date.UTC(2026, 11, 31); day += 3 * 864e5) {
    const signed = new Date(day).toISOString().slice(0, 10);
    const announced = new Date(day - 70 * 864e5).toISOString().slice(0, 10);
    for (const eik of ['111111111', '222222222']) {
      tender.run(`t${n}`, announced);
      contract.run(
        `c${n}`,
        `Договор ${n}`,
        `eik:${eik}`,
        `t${n}`,
        signed,
        n % 4 === 0 ? null : (n % 3) + 1,
      );
      n++;
    }
  }
  return d1FromSqlite(db!);
}

const inside = (band: DaySpan[] | undefined, day: string) =>
  (band ?? []).some(([a, b]) => a <= day && day <= b);

it('draws the band exactly where the red numbers are: contract by contract, across every edge', async () => {
  const result = await getTimelineIntervals(fixture(), 'person', ['official', 'alias']);
  expect(result.procurements.length).toBeGreaterThan(2800);
  const wrong = result.procurements.filter(
    (p) => p.tied !== inside(result.bands[p.eik], p.signedAt),
  );
  expect(wrong).toEqual([]);
  // And the test is not vacuous: both companies have red and non-red contracts.
  for (const eik of ['111111111', '222222222']) {
    const own = result.procurements.filter((p) => p.eik === eik);
    expect(own.some((p) => p.tied)).toBe(true);
    expect(own.some((p) => !p.tied)).toBe(true);
  }
});

it('carries the announcement, and drops one that postdates the signing', async () => {
  const d1 = fixture();
  db!.exec("UPDATE tenders SET published_at='2030-01-01' WHERE id='t0'");
  const { procurements } = await getTimelineIntervals(d1, 'person', ['official', 'alias']);
  const first = procurements.find((p) => p.id === 'c0')!;
  expect(first.announcedAt).toBeNull();
  const other = procurements.find((p) => p.id === 'c2')!;
  expect(other.announcedAt! < other.signedAt).toBe(true);
  // The offers received ride along for the tooltip, and stay unknown where the source is silent.
  expect(other.bids).toBe(3);
  expect(other.authorityId).toBe('auth:1'); // the buyer, for telling the person's own institution apart
  expect(first.bids).toBeNull();
});

it('reads the declared years per scope, without the disputed one', async () => {
  const { declared } = await getTimelineIntervals(fixture(), 'person', ['official']);
  expect(declared.filter((d) => d.eik === '222222222').map((d) => d.year)).toEqual([
    '2017',
    '2018',
    '2019',
    '2020',
    '2022',
    '2023',
  ]);
  expect(new Set(declared.map((d) => d.scope))).toEqual(new Set(['self']));
});

it('has no band without an office, or without a tie', () => {
  const role = {
    eik: '1',
    addedOn: '2020-01-01',
    removedOn: null,
    removedSet: 0,
    uncertainAfter: null,
    observedOn: '2021-01-01',
  };
  expect(overlapBands({ officeYears: [], bounds: [], roles: [role], declared: [] })).toEqual({});
  expect(
    overlapBands({
      officeYears: ['2020'],
      bounds: [{ opened: '2020-01-01', closed: '2020-12-31' }],
      roles: [],
      declared: [],
    }),
  ).toEqual({});
  // A standing role with no successful read supports nothing, as in the SQL.
  expect(
    overlapBands({
      officeYears: ['2020'],
      bounds: [{ opened: '2020-01-01', closed: '2020-12-31' }],
      roles: [{ ...role, observedOn: null }],
      declared: [],
    }),
  ).toEqual({});
});

it('ignores a role it cannot place in time, and ties a declarant the register does not identify by the declarations alone', async () => {
  const role = (over: Partial<Parameters<typeof overlapBands>[0]['roles'][number]> = {}) => ({
    eik: '1',
    addedOn: '2020-01-01',
    removedOn: null,
    removedSet: 0,
    uncertainAfter: null,
    observedOn: '2021-12-31',
    ...over,
  });
  const office = {
    officeYears: ['2020', '2021'],
    bounds: [{ opened: '2020-01-01', closed: '2021-12-31' }],
    declared: [],
  };
  // No start, an end the register records but no date can be read from, an end before the start.
  expect(overlapBands({ ...office, roles: [role({ addedOn: null })] })).toEqual({});
  expect(overlapBands({ ...office, roles: [role({ removedSet: 1, removedOn: null })] })).toEqual(
    {},
  );
  expect(overlapBands({ ...office, roles: [role({ uncertainAfter: '2019-06-01' })] })).toEqual({});
  // Two roles from the same day: the longer one decides where the band ends.
  expect(
    overlapBands({
      ...office,
      roles: [role({ observedOn: '2021-03-31' }), role({ observedOn: '2020-06-30' })],
    }),
  ).toEqual({ '1': [['2020-01-01', '2021-03-31']] });
  // Without a registry identity the person has no roles: only the declared stake ties them.
  const { bands } = await getTimelineIntervals(fixture(), null, ['official', 'alias']);
  expect(Object.keys(bands)).toEqual(['222222222']);
});

it('clips a long subject: the mark needs a label, the contract page has the whole text', async () => {
  const d1 = fixture();
  db!.exec(
    `UPDATE contracts SET contract_subject = '${'Ремонт на път '.repeat(30)}' WHERE id = 'c2'`,
  );
  const { procurements } = await getTimelineIntervals(d1, 'person', ['official', 'alias']);
  const long = procurements.find((p) => p.id === 'c2')!;
  expect(long.subject!.length).toBeLessThanOrEqual(TIMELINE_SUBJECT_CHARS);
  expect(long.subject!.endsWith('…')).toBe(true);
  expect(procurements.find((p) => p.id === 'c0')!.subject).toBe('Договор 0');
});

// The office at „Община Тест" in the fixture, as the profile's office bars cut it from the same filings
// (officeSpans in apps/web): 2017–2019 opened by an entry filing, 2021–2022 with neither end filed, and
// 2024 closed by an exit filing. 2020 and 2023 have no filing.
const fixtureOffice: InstitutionOfficeSpan[] = [
  { from: '2017-01-01', to: '2019-12-31', knownStart: '2017-04-20', knownEnd: null },
  { from: '2021-01-01', to: '2022-12-31', knownStart: null, knownEnd: null },
  { from: '2024-01-01', to: '2024-08-12', knownStart: null, knownEnd: '2024-08-12' },
];

it("tells an own institution's contracts apart: overlap, outside the period, period not established", async () => {
  const { procurements } = await getTimelineIntervals(fixture(), 'person', ['official', 'alias']);
  const expected = (day: string, tied: boolean) =>
    day < '2017-01-01' // before an office whose entry was filed more than a month later
      ? 'outside'
      : day <= '2019-12-31' ||
          ('2021-01-01' <= day && day <= '2022-12-31') ||
          ('2024-01-01' <= day && day <= '2024-08-12')
        ? tied
          ? 'overlap'
          : 'in-office'
        : day < '2024-01-01' // 2020 and 2023: after a run with no exit filing
          ? 'unknown'
          : 'outside'; // after the exit filing, nothing later
  const got = procurements.map((p) => ({
    id: p.id,
    period: institutionPeriod(fixtureOffice, p.signedAt, p.tied),
    expected: expected(p.signedAt, p.tied),
  }));
  expect(got.filter((g) => g.period !== g.expected)).toEqual([]);
  // Every case occurs, so the check is not vacuous; and an overlap is always a red contract.
  for (const period of ['overlap', 'in-office', 'outside', 'unknown'])
    expect(got.filter((g) => g.period === period).length).toBeGreaterThan(10);
  for (const p of procurements)
    if (institutionPeriod(fixtureOffice, p.signedAt, p.tied) === 'overlap')
      expect(p.tied).toBe(true);
});

it('calls a date outside the office only where a filing bounds that side', () => {
  const run = (over: Partial<InstitutionOfficeSpan> = {}): InstitutionOfficeSpan => ({
    from: '2019-01-01',
    to: '2020-12-31',
    knownStart: null,
    knownEnd: null,
    ...over,
  });
  // No declared office years at all: nothing is established either way.
  expect(institutionPeriod([], '2020-05-01', true)).toBe('unknown');
  // Inside the declared years: an overlap only when red.
  expect(institutionPeriod([run()], '2020-05-01', true)).toBe('overlap');
  expect(institutionPeriod([run()], '2020-05-01', false)).toBe('in-office');
  // Before a start nobody filed, after an end nobody filed: unknown, even when red elsewhere.
  expect(institutionPeriod([run()], '2018-05-01', false)).toBe('unknown');
  expect(institutionPeriod([run()], '2021-05-01', true)).toBe('unknown');
  // An exit filing ends the office by that day; the contract the day after is outside.
  const closed = run({ to: '2020-06-30', knownEnd: '2020-06-30' });
  expect(institutionPeriod([closed], '2020-06-30', false)).toBe('in-office');
  expect(institutionPeriod([closed], '2020-07-01', false)).toBe('outside');
  // An entry filing: a month of lag is allowed, so a January filing leaves December open.
  const opened = run({ knownStart: '2019-01-15' });
  expect(institutionPeriod([opened], '2018-12-20', false)).toBe('unknown');
  expect(institutionPeriod([opened], '2018-12-10', false)).toBe('outside');
  expect(institutionPeriod([run({ knownStart: '2019-06-01' })], '2018-12-31', false)).toBe(
    'outside',
  );
  // Between two runs, both sides must be bounded.
  const later = run({ from: '2023-01-01', to: '2023-12-31', knownStart: '2023-03-01' });
  expect(institutionPeriod([closed, later], '2022-01-01', false)).toBe('outside');
  expect(institutionPeriod([run(), later], '2022-01-01', false)).toBe('unknown');
  expect(institutionPeriod([closed, { ...later, knownStart: null }], '2022-01-01', false)).toBe(
    'unknown',
  );
  // A timestamp is read as its day.
  expect(institutionPeriod([closed], '2020-06-30T23:00:00Z', false)).toBe('in-office');
});
