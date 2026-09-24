// The band must agree with the red numbers to the day. This builds a person whose ties and offices have
// every edge the activity CTE knows — a role that ended and one that stands, an uncertain end, a declared
// window with a disputed year, an office with a gap year, an exit filing mid-year, two declarants — signs
// a contract every few days across a decade, and checks each one: red if and only if inside the band.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getTimelineIntervals, overlapBands, type DaySpan } from './person-intervals';

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
    CREATE TABLE interest_link_evidence(link_key,evidence_kind);
    CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
    CREATE TABLE person_registry_links(person_id,registry_indent);
    CREATE TABLE bidders(id,name,eik_normalized,ownership_kind);
    CREATE TABLE company_totals(bidder_id,contracts);
    CREATE TABLE tenders(id,title,authority_id,published_at);
    CREATE TABLE authorities(id,name);
    CREATE TABLE declarations(id,person_id,institution,position,declared_year);
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
