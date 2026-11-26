import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { d1FromSqlite } from '@sigma/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { getContract } from './queries/details';
import { streamContractsCsv } from './queries/contracts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migrationDir = 'packages/db/migrations';
const migrations = readdirSync(resolve(root, migrationDir))
  .filter((name) => name.endsWith('.sql'))
  .sort();
const handles: DatabaseSync[] = [];

function freshDb(legacy = false) {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  for (const migration of legacy ? migrations.filter((name) => name < '0029') : migrations) {
    db.exec(read(`${migrationDir}/${migration}`));
  }
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function script(db: DatabaseSync, name: string) {
  db.exec(read(`scripts/${name}.sql`));
}

function staging(db: DatabaseSync) {
  for (const kind of ['view', 'table']) {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name GLOB 'raw_*'")
      .all(kind)) {
      db.exec(`DROP ${kind} "${String(name)}"`);
    }
  }
  script(db, 'work-staging-schema');
}

function signing(
  db: DatabaseSync,
  options: {
    signing?: number | null;
    currency?: string | null;
    contractorEik?: string;
    contractorName?: string;
    lotId?: string;
    unp?: string;
    own?: number | null;
    ownCurrency?: string;
    procedure?: number | null;
    procedureCurrency?: string;
    source?: string;
    contractNumber?: string;
  } = {},
) {
  const {
    signing = 10_000,
    currency = 'EUR',
    contractorEik,
    contractorName = 'Test Supplier',
    lotId,
    unp = 'TEST-UNP',
    own = 100_000,
    ownCurrency = 'EUR',
    procedure = 100_000,
    procedureCurrency = 'EUR',
    source = 'ocds:2026-06-01',
    contractNumber = 'TEST-CONTRACT',
  } = options;
  db.prepare(
    `INSERT INTO raw_tenders (source, fetched_at, unp, authority_eik, authority_name, estimated_value, currency)
      VALUES ('eop:tenders:2026-06-01', '2026-06-01', ?, 'TEST-ORG', 'Test Authority', ?, ?)`,
  ).run(unp, procedure, procedureCurrency);
  db.prepare(
    `INSERT INTO raw_contracts (source, fetched_at, unp, authority_eik, authority_name, contract_number,
      contract_date, signing_value, currency, estimated_value, procurement_currency, contractor_name, contractor_eik, lot_id)
    VALUES (?, '2026-06-01', ?, 'TEST-ORG', 'Test Authority', ?,
      '2026-06-02', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source,
    unp,
    contractNumber,
    signing,
    currency,
    own,
    ownCurrency,
    contractorName,
    contractorEik ?? null,
    lotId ?? null,
  );
}

type Annex = [
  before: number | null,
  after: number | null,
  delta?: number | null,
  restated?: number,
  treatment?: string,
  currency?: string,
];

function amendment(
  db: DatabaseSync,
  number: number,
  [before, after, delta = null, restated, treatment, currency = 'EUR']: Annex,
  contractNumber = 'TEST-CONTRACT',
  options: { contractorEik?: string; source?: string } = {},
) {
  const date = `2026-06-0${2 + number}`;
  db.prepare(
    `INSERT INTO raw_amendments (source, fetched_at, unp, document_number, contract_number,
      published_at, value_before, value_after, value_delta, value_after_restated, value_treatment, currency, contractor_eik)
    VALUES (?, ?, 'TEST-UNP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.source ?? `eop:annexes:${date}`,
    date,
    `ANNEX-${number}`,
    contractNumber,
    date,
    before,
    after,
    delta,
    restated ?? null,
    treatment ?? null,
    currency,
    options.contractorEik ?? null,
  );
}

function full(db: DatabaseSync) {
  for (const name of [
    'resolve-amendment-contracts',
    'derive-amendments',
    'normalize-raw',
    'promote-amendments',
    'precompute',
  ]) {
    script(db, name);
  }
}

function daily(db: DatabaseSync) {
  script(db, 'refresh-slice');
}

function anchorLinks(db: DatabaseSync, table: 'raw_amendments' | 'amendments') {
  return db
    .prepare(
      `SELECT document_number, contract_number, contract_number_raw, link_method
    FROM ${table} ORDER BY document_number`,
    )
    .all();
}

describe('alternate-number annex links across refresh windows', () => {
  const first = {
    document_number: 'ANNEX-1',
    contract_number: 'TEST-CONTRACT',
    contract_number_raw: 'ALT',
    link_method: 'value_anchor',
  };
  const unassigned = {
    document_number: 'ANNEX-3',
    contract_number: 'ALT',
    contract_number_raw: null,
    link_method: null,
  };
  const sibling: Annex = [13_000, 15_000, null, undefined, undefined, 'USD'];

  it('retains both disagreeing votes when a committed resolution is retried', () => {
    const db = freshDb();
    staging(db);
    signing(db);
    signing(db, { contractNumber: 'TEST-SECOND', signing: 20_000 });
    amendment(db, 1, [10_000, 11_000], 'ALT');
    daily(db);
    staging(db);
    amendment(db, 2, [20_000, 21_000], 'ALT');
    amendment(db, 3, sibling, 'ALT');

    const [resolution, derive] = read('scripts/refresh-slice.sql').split('-- @refresh-batch setup');
    const linked = { ...first, document_number: 'ANNEX-2', contract_number: 'TEST-SECOND' };
    db.exec(resolution!);
    expect(anchorLinks(db, 'raw_amendments')).toEqual([linked, unassigned]);
    db.exec(resolution!);
    expect(anchorLinks(db, 'raw_amendments')).toEqual([linked, unassigned]);
    db.exec(derive!);
    expect(anchorLinks(db, 'amendments')).toEqual([first, linked, unassigned]);
    expect(snapshot(db).totals).toEqual({
      home: 32_000,
      company: 32_000,
      authority: 32_000,
      flow: 32_000,
    });
  });

  it.each(['staged', 'served', 'different-currency', 'corrected-in-staging'])(
    'rechecks the served anchor when the later signing is %s',
    (competitor) => {
      const db = freshDb();
      staging(db);
      signing(db);
      amendment(db, 1, [10_000, 11_000], 'ALT');
      daily(db);
      staging(db);
      signing(db, {
        contractNumber: 'TEST-SECOND',
        currency: competitor === 'different-currency' ? 'BGN' : 'EUR',
      });
      if (competitor === 'served' || competitor === 'corrected-in-staging') {
        daily(db);
        staging(db);
      }
      if (competitor === 'corrected-in-staging') {
        signing(db, {
          contractNumber: 'TEST-SECOND',
          signing: 20_000,
          source: 'ocds:2026-06-04',
        });
      }
      amendment(db, 3, sibling, 'ALT');
      daily(db);

      const expectedSibling =
        competitor === 'different-currency' || competitor === 'corrected-in-staging'
          ? { ...first, document_number: 'ANNEX-3' }
          : unassigned;
      expect(anchorLinks(db, 'amendments')).toEqual([first, expectedSibling]);
    },
  );
});

describe('current publication evidence for annex inheritance', () => {
  // Synthetic branch-shaped identifiers with a zero prefix and valid check digits.
  const supplierA = '0000000000015';
  const supplierB = '0000000000023';
  const eop = 'eop:contracts:2026-06-01';
  const newerEop = 'eop:contracts:2026-06-05';
  const ocds = 'ocds:2026-06-01';
  const anchor: Annex = [10_000, 11_000];
  const sibling: Annex = [13_000, 15_000, null, undefined, undefined, 'USD'];
  const [resolution, derive] = read('scripts/refresh-slice.sql').split('-- @refresh-batch setup');

  function finish(db: DatabaseSync) {
    db.exec(resolution!);
    const linked = anchorLinks(db, 'raw_amendments');
    db.exec(resolution!);
    expect(anchorLinks(db, 'raw_amendments')).toEqual(linked);
    db.exec(derive!);
  }

  function ownership(db: DatabaseSync, number: number) {
    return db
      .prepare(
        `SELECT contract_number, value_anchor_kind, value_anchor_contractor_eik
      FROM amendments WHERE document_number = ?`,
      )
      .get(`ANNEX-${number}`);
  }

  it.each([
    {
      previous: eop,
      current: newerEop,
      value: 10_000,
      currency: 'EUR',
      expected: 10_000,
      link: true,
    },
    {
      previous: eop,
      current: newerEop,
      value: 20_000,
      currency: 'EUR',
      expected: 20_000,
      link: false,
    },
    { previous: eop, current: newerEop, value: 0, currency: 'EUR', expected: 0, link: false },
    { previous: eop, current: newerEop, value: null, currency: 'EUR', expected: null, link: false },
    {
      previous: eop,
      current: newerEop,
      value: 10_000,
      currency: null,
      expected: 10_000,
      link: false,
    },
    { previous: eop, current: eop, value: 0, currency: 'EUR', expected: 0, link: false },
    { previous: ocds, current: newerEop, value: 0, currency: 'EUR', expected: 0, link: false },
    {
      previous: ocds,
      current: newerEop,
      value: 10_000,
      currency: 'EUR',
      expected: 10_000,
      link: true,
    },
    {
      previous: eop,
      current: 'ocds:2026-06-05',
      value: 0,
      currency: 'EUR',
      expected: 10_000,
      link: true,
    },
    {
      previous: eop,
      current: 'other:2026-06-05',
      value: 20_000,
      currency: 'EUR',
      expected: 10_000,
      link: true,
    },
  ])('matches the current signing for $previous → $current ($value $currency)', (testCase) => {
    for (const grouping of ['full', 'cumulative', 'served', 'update-first']) {
      const db = freshDb();
      staging(db);
      signing(db, { source: testCase.previous });
      amendment(db, 1, anchor, 'ALT');
      if (grouping === 'served' || grouping === 'update-first') {
        daily(db);
        expect(ownership(db, 1)).toMatchObject({
          contract_number: 'TEST-CONTRACT',
          value_anchor_kind: 'direct',
        });
        staging(db);
      }
      signing(db, {
        source: testCase.current,
        signing: testCase.value,
        currency: testCase.currency,
      });
      if (grouping === 'update-first') {
        daily(db);
        staging(db);
      }
      amendment(db, 3, sibling, 'ALT');
      if (grouping === 'full') full(db);
      else finish(db);

      expect(ownership(db, 3), grouping).toMatchObject({
        contract_number: testCase.link ? 'TEST-CONTRACT' : 'ALT',
        value_anchor_kind: testCase.link ? 'inherited' : null,
      });
      const contract = snapshot(db).contract;
      if (testCase.expected === null && (grouping === 'full' || grouping === 'cumulative')) {
        // First admission has no amount when the NULL signing has no linked annex.
        expect(contract, grouping).toBeUndefined();
      } else {
        expect(contract, grouping).toMatchObject({ signing_value: testCase.expected });
      }
      if (grouping === 'served' || grouping === 'update-first') {
        expect(ownership(db, 1), grouping).toMatchObject({
          contract_number: 'TEST-CONTRACT',
          value_anchor_kind: 'direct',
        });
      }
    }
  });

  it('excludes a served OCDS signing when EOP replaces its document under a different procedure', () => {
    const db = freshDb();
    staging(db);
    signing(db, { source: ocds });
    amendment(db, 1, anchor, 'ALT');
    daily(db);
    staging(db);
    signing(db, { source: newerEop, unp: 'TEST-OTHER' });
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
    expect(db.prepare('SELECT tender_id FROM contracts').all()).toEqual([
      { tender_id: 't:TEST-OTHER' },
    ]);
  });

  it('withholds a staged signing that cannot replace an existing admin contract', () => {
    const db = freshDb();
    staging(db);
    signing(db, { source: eop, signing: 20_000 });
    daily(db);
    db.exec(`UPDATE contracts SET id = 'c:TEST-ADMIN', own_estimate_source = NULL,
      signing_currency_raw = NULL, signing_contractor_eik = NULL`);

    staging(db);
    signing(db, { source: newerEop });
    amendment(db, 1, anchor, 'ALT');
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 1)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
    expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
    expect(db.prepare('SELECT id, signing_value FROM contracts').all()).toEqual([
      { id: 'c:TEST-ADMIN', signing_value: 20_000 },
    ]);
  });

  it.each([
    { adminEik: supplierB, adminLot: '1', stagedA: true },
    { adminEik: supplierA, adminLot: '2', stagedA: true },
    { adminEik: supplierA, adminLot: '1', stagedA: false },
  ])(
    'keeps admin overlap from supplying proof across bidder and lot variants ($adminEik, $adminLot)',
    ({ adminEik, adminLot, stagedA }) => {
      const db = freshDb();
      staging(db);
      signing(db, { source: eop, signing: 30_000, contractorEik: adminEik, lotId: adminLot });
      daily(db);
      db.exec(`UPDATE contracts SET id = 'c:TEST-ADMIN', own_estimate_source = NULL,
      signing_currency_raw = NULL, signing_contractor_status = NULL, signing_contractor_eik = NULL`);
      staging(db);
      signing(db, {
        source: newerEop,
        contractorName: 'Synthetic Renamed Supplier',
        contractorEik: `ЕИК ${supplierA}`,
        lotId: 'LOT-001',
      });
      signing(db, { source: newerEop, contractNumber: 'TEST-SECOND', signing: 20_000 });
      amendment(db, 1, anchor, 'ALT', { contractorEik: supplierA });
      amendment(db, 2, [20_000, 21_000], 'ALT');
      amendment(db, 3, sibling, 'ALT');
      finish(db);

      const eopContracts = db
        .prepare(
          `SELECT contract_number, annex_count, amount_eur FROM contracts
        WHERE id GLOB 'c:e:*' ORDER BY contract_number`,
        )
        .all();
      expect(ownership(db, 1)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
      expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
      expect(eopContracts).toEqual([
        ...(stagedA
          ? [{ contract_number: 'TEST-CONTRACT', annex_count: 0, amount_eur: 10_000 }]
          : []),
        { contract_number: 'TEST-SECOND', annex_count: 1, amount_eur: 21_000 },
      ]);
      expect(
        db.prepare("SELECT amount_eur, annex_count FROM contracts WHERE id = 'c:TEST-ADMIN'").get(),
      ).toEqual({ amount_eur: 30_000, annex_count: 0 });
    },
  );

  it.each(['full', 'cumulative', 'served'])(
    'keeps unverified evidence from proving or passing on a competing owner (%s)',
    (grouping) => {
      const db = freshDb();
      const unverifiedId = '0000000000';
      staging(db);
      signing(db, { source: eop, contractorEik: unverifiedId });
      signing(db, { source: eop, contractNumber: 'TEST-SECOND', signing: 20_000 });
      if (grouping === 'served') {
        daily(db);
        staging(db);
      }
      amendment(db, 1, anchor, 'ALT', { contractorEik: unverifiedId });
      amendment(db, 2, [20_000, 21_000], 'ALT');
      amendment(db, 3, sibling, 'ALT');
      if (grouping === 'full') full(db);
      else finish(db);

      expect(ownership(db, 1)).toEqual({
        contract_number: 'ALT',
        value_anchor_kind: null,
        value_anchor_contractor_eik: null,
      });
      expect(ownership(db, 2)).toMatchObject({
        contract_number: 'TEST-SECOND',
        value_anchor_kind: 'direct',
      });
      expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
      expect(
        db.prepare('SELECT contractor_id_status FROM amendments ORDER BY document_number').all(),
      ).toEqual([
        { contractor_id_status: 'unverified' },
        { contractor_id_status: 'absent' },
        { contractor_id_status: 'absent' },
      ]);
      expect(
        db
          .prepare(
            `SELECT signing_contractor_eik, signing_contractor_status FROM contracts
          ORDER BY contract_number`,
          )
          .all(),
      ).toEqual([
        { signing_contractor_eik: null, signing_contractor_status: 'unverified' },
        { signing_contractor_eik: null, signing_contractor_status: 'absent' },
      ]);
    },
  );

  it.each([
    ['full', full],
    ['slice', daily],
  ] as const)(
    'keeps unverified OCDS supplier IDs out of the public party key and ID (%s)',
    (_mode, derive) => {
      const db = freshDb();
      staging(db);
      const insert = db.prepare(
        `INSERT INTO raw_ocds_parties (source, fetched_at, ocid, party_id, eik, is_supplier)
        VALUES ('ocds:2026-06-01','2026-06-01','ocds-test',?,?,?)`,
      );
      insert.run('SUPPLIER-BAD', `${supplierA}\0TEST`, 1);
      insert.run('SUPPLIER-VALID', supplierA, 1);
      insert.run('BUYER', 'TEST-ORG', 0);
      insert.run('TEST-REFERENCE-COPY', 'TEST-REFERENCE-COPY', 1);
      derive(db);
      expect(
        db.prepare('SELECT party_id, party_key, eik FROM parties ORDER BY party_id').all(),
      ).toEqual([
        {
          party_id: null,
          party_key: 'ocds-observation:["ocds-test",null,null,null,null,null,null,null]',
          eik: null,
        },
        {
          party_id: 'BUYER',
          party_key: 'eik:TEST-ORG:ocid:ocds-test:party:BUYER',
          eik: 'TEST-ORG',
        },
        { party_id: 'SUPPLIER-BAD', party_key: 'ocds-ref:["ocds-test","SUPPLIER-BAD"]', eik: null },
        {
          party_id: 'SUPPLIER-VALID',
          party_key: `eik:${supplierA}:ocid:ocds-test:party:SUPPLIER-VALID`,
          eik: supplierA,
        },
      ]);
    },
  );

  it('retires earlier exact copies and ranks the remaining party against served winners', () => {
    const db = freshDb();
    const stage = (
      day: number,
      id: string,
      eik: string,
      supplier: number,
      name: string,
      appearance: string,
    ) => {
      db.prepare(
        `INSERT INTO raw_ocds_parties
        (source,fetched_at,ocid,party_id,eik,is_supplier,name,appearance)
        VALUES (?,'2026-08-12','ocds-test',?,?,?,?,?)`,
      ).run(`ocds:2026-08-${day}`, id, eik, supplier, name, appearance);
    };
    staging(db);
    stage(11, 'TEST-COPY', 'TEST-COPY', 0, 'Earlier appearance', 'same-source-appearance');
    stage(11, 'ORG-3', 'TEST-OLD', 1, 'Z earlier occupant', 'old-occupant');
    daily(db);
    expect(db.prepare("SELECT eik FROM parties WHERE party_id = 'TEST-COPY'").get()?.eik).toBe(
      'TEST-COPY',
    );
    staging(db);
    stage(12, 'TEST-COPY', 'TEST-COPY', 1, 'Later appearance', 'same-source-appearance');
    stage(12, 'ORG-3', 'TEST-NEW', 1, 'A later occupant', 'new-occupant');
    daily(db);
    staging(db);
    stage(11, 'TEST-COPY', 'TEST-COPY', 0, 'Earlier appearance', 'same-source-appearance');
    stage(11, 'ORG-3', 'TEST-OLD', 1, 'Z earlier occupant', 'old-occupant');
    stage(12, 'ORG-3', 'TEST-TIE', 1, 'Z same-day winner', 'tie-occupant');
    daily(db);
    const rows = db.prepare('SELECT * FROM parties ORDER BY party_key').all();
    expect(JSON.stringify(rows)).not.toContain('TEST-COPY');
    expect(rows.filter((row) => row.party_id === null)).toHaveLength(2);
    expect(rows.find((row) => row.party_id === 'ORG-3')).toMatchObject({
      name: 'Z same-day winner',
      source: 'ocds:2026-08-12',
      eik: null,
    });
  });

  it.each(['EUR', 'BGN'])(
    'keeps original contractor evidence against a %s value tie',
    (currency) => {
      for (const grouping of ['full', 'cumulative', 'served']) {
        const db = freshDb();
        staging(db);
        signing(db, { source: eop, contractorEik: supplierA });
        signing(db, {
          source: eop,
          contractNumber: 'TEST-SECOND',
          contractorEik: currency === 'EUR' ? supplierB : supplierA,
          currency,
        });
        amendment(db, 1, anchor, 'ALT', { contractorEik: `ЕИК ${supplierA}` });
        if (grouping === 'served') {
          daily(db);
          staging(db);
        }
        amendment(db, 3, sibling, 'ALT');
        if (grouping === 'full') full(db);
        else finish(db);
        expect(ownership(db, 1), grouping).toEqual({
          contract_number: 'TEST-CONTRACT',
          value_anchor_kind: 'direct',
          value_anchor_contractor_eik: supplierA,
        });
        expect(ownership(db, 3), grouping).toEqual({
          contract_number: 'TEST-CONTRACT',
          value_anchor_kind: 'inherited',
          value_anchor_contractor_eik: null,
        });
      }
    },
  );

  it.each(['full', 'cumulative', 'served'])(
    'uses only the winning annex publication as evidence (%s)',
    (grouping) => {
      const db = freshDb();
      staging(db);
      signing(db, { source: eop, contractorEik: supplierA });
      amendment(db, 1, anchor, 'ALT', { contractorEik: supplierA });
      if (grouping === 'served') {
        daily(db);
        staging(db);
      }
      amendment(db, 1, anchor, 'ALT', {
        source: 'eop:annexes:2026-06-05',
        contractorEik: supplierB,
      });
      amendment(db, 3, sibling, 'ALT');
      if (grouping === 'full') full(db);
      else finish(db);
      expect(ownership(db, 1)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
      expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
    },
  );

  it('keeps historic inherited ownership when the signing changes, with no new inheritance', () => {
    const db = freshDb();
    staging(db);
    signing(db, { source: eop, contractorEik: supplierA });
    amendment(db, 1, anchor, 'ALT', { contractorEik: supplierA });
    amendment(db, 2, [20_000, 12_000], 'ALT', { contractorEik: supplierB });
    daily(db);
    expect(ownership(db, 2)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'inherited',
    });

    staging(db);
    signing(db, { source: newerEop, signing: 20_000, contractorEik: supplierA });
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 1)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'direct',
    });
    expect(ownership(db, 2)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'inherited',
    });
    expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });
    expect(snapshot(db).contract).toMatchObject({ annex_count: 2, amount_eur: 12_000 });

    const rebuilt = freshDb();
    staging(rebuilt);
    signing(rebuilt, { source: eop, contractorEik: supplierA });
    signing(rebuilt, { source: newerEop, signing: 20_000, contractorEik: supplierA });
    amendment(rebuilt, 1, anchor, 'ALT', { contractorEik: supplierA });
    amendment(rebuilt, 2, [20_000, 12_000], 'ALT', { contractorEik: supplierB });
    amendment(rebuilt, 3, sibling, 'ALT');
    full(rebuilt);
    expect(ownership(rebuilt, 3)).toEqual(ownership(db, 3));
  });

  it('does not promote a historical inherited link to a witness even if its value now matches', () => {
    const db = freshDb();
    staging(db);
    signing(db, { source: eop });
    amendment(db, 1, anchor, 'ALT');
    amendment(db, 2, [20_000, 12_000], 'ALT');
    daily(db);
    expect(ownership(db, 2)).toMatchObject({ value_anchor_kind: 'inherited' });

    staging(db);
    signing(db, { source: newerEop, signing: 20_000 });
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });

    // Replaying the original publication gives the resolver a fresh direct match.
    staging(db);
    amendment(db, 2, [20_000, 12_000], 'ALT');
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 2)).toMatchObject({ value_anchor_kind: 'direct' });
    expect(ownership(db, 3)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'inherited',
    });
  });

  it('cannot use a migrated value link as a direct witness until source replay', () => {
    const db = freshDb(true);
    db.exec(`INSERT INTO amendments (id, natural_key, unp, contract_number, contract_number_raw,
      link_method, document_number, source, value_before, value_after, currency)
      VALUES ('am:TEST-UNP:ALT:ANNEX-1', 'am:TEST-UNP:ALT:ANNEX-1', 'TEST-UNP', 'TEST-CONTRACT', 'ALT',
        'value_anchor', 'ANNEX-1', 'eop:annexes:2026-06-03', 10000, 11000, 'EUR')`);
    db.exec(read(`${migrationDir}/0029_contract_value_evidence.sql`));
    staging(db);
    signing(db, { source: eop });
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 1)).toEqual({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: null,
      value_anchor_contractor_eik: null,
    });
    expect(ownership(db, 3)).toMatchObject({ contract_number: 'ALT', value_anchor_kind: null });

    staging(db);
    amendment(db, 1, anchor, 'ALT');
    amendment(db, 3, sibling, 'ALT');
    finish(db);
    expect(ownership(db, 1)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'direct',
    });
    expect(ownership(db, 3)).toMatchObject({
      contract_number: 'TEST-CONTRACT',
      value_anchor_kind: 'inherited',
    });
  });
});

function snapshot(db: DatabaseSync) {
  return {
    contract: db
      .prepare(
        `SELECT currency, signing_value, round(signing_value_eur, 2) AS signing_eur,
      amount, amount_eur, current_value, current_value_currency, current_value_eur, value_flag, annex_count FROM contracts`,
      )
      .get(),
    totals: db
      .prepare(
        `SELECT value_eur AS home, (SELECT SUM(won_eur) FROM company_totals) AS company,
      (SELECT SUM(spent_eur) FROM authority_totals) AS authority,
      (SELECT SUM(won_eur) FROM flow_pairs) AS flow FROM home_totals`,
      )
      .get(),
  };
}

describe('contract value evidence across full and daily imports', () => {
  it.each<{
    label: string;
    first: Annex;
    second: Annex;
    amount: number;
    flag: string;
  }>([
    {
      label: 'a conflicting raw delta followed by metadata',
      first: [10_000, 20_000, 1_000],
      second: [null, null],
      amount: 20_000,
      flag: 'ok',
    },
    {
      label: 'a restated total that only falsely matches the next base',
      first: [10_000, 25_000, 15_000, 15_000, 'total_restated'],
      second: [16_000, 17_000],
      amount: 17_000,
      flag: 'ok',
    },
    {
      label: 'an unchanged restatement whose raw total is reused',
      first: [10_000, 20_000, 10_000, 10_000, 'unchanged_restated'],
      second: [20_000, 22_000],
      amount: 10_000,
      flag: 'annex_total_suspect',
    },
    {
      label: 'a doubled total carried forward by an unchanged annex',
      first: [10_000, 20_000],
      second: [20_000, 20_000],
      amount: 10_000,
      flag: 'annex_total_suspect',
    },
    {
      label: 'a doubled total carried forward unchanged in lev at the peg',
      first: [10_000, 20_000],
      second: [39_116.6, 39_116.6, null, undefined, undefined, 'BGN'],
      amount: 10_000,
      flag: 'annex_total_suspect',
    },
    {
      label: 'a doubled total that a later annex corrects',
      first: [10_000, 20_000],
      second: [20_000, 11_000],
      amount: 11_000,
      flag: 'ok',
    },
    {
      label: 'a real increase followed by an unchanged annex',
      first: [10_000, 12_000],
      second: [12_000, 12_000],
      amount: 12_000,
      flag: 'ok',
    },
  ])('keeps $label consistent through replay and catch-up', ({ first, second, amount, flag }) => {
    const rebuilt = freshDb();
    const caughtUp = freshDb();
    for (const db of [rebuilt, caughtUp]) {
      staging(db);
      signing(db);
      amendment(db, 1, first);
      amendment(db, 2, second);
    }
    full(rebuilt);
    daily(caughtUp);
    const expected = snapshot(rebuilt);
    expect(expected.contract).toMatchObject({
      value_flag: flag,
      amount_eur: amount,
      annex_count: 2,
    });
    expect(expected.totals).toEqual({
      home: amount,
      company: amount,
      authority: amount,
      flow: amount,
    });
    expect(snapshot(caughtUp)).toEqual(expected);

    const ordered = freshDb();
    staging(ordered);
    signing(ordered);
    daily(ordered);
    for (const [index, annex] of [first, second].entries()) {
      staging(ordered);
      amendment(ordered, index + 1, annex);
      daily(ordered);
      const beforeReplay = snapshot(ordered);
      daily(ordered);
      expect(snapshot(ordered)).toEqual(beforeReplay);
    }
    expect(snapshot(ordered)).toEqual(expected);
    for (const db of [rebuilt, caughtUp, ordered]) {
      expect(
        db
          .prepare(
            `SELECT document_number, value_evidence_known, raw_value_after, raw_value_delta
        FROM amendments ORDER BY document_number`,
          )
          .all(),
      ).toEqual([
        {
          document_number: 'ANNEX-1',
          value_evidence_known: 1,
          raw_value_after: first[1],
          raw_value_delta: first[2] ?? null,
        },
        {
          document_number: 'ANNEX-2',
          value_evidence_known: 1,
          raw_value_after: second[1],
          raw_value_delta: second[2] ?? null,
        },
      ]);
    }
  });

  it.each([false, true])(
    'recovers symbolic signing even if initially masked by value_suspect (%s)',
    (masked) => {
      const options = { signing: 1, currency: 'BGN' };
      const rebuilt = freshDb();
      staging(rebuilt);
      signing(rebuilt, options);
      amendment(rebuilt, 1, [null, 21_000_000]);
      amendment(rebuilt, 2, [null, 100]);
      full(rebuilt);
      expect(snapshot(rebuilt).contract).toMatchObject({
        value_flag: 'value_low',
        amount_eur: 100,
      });

      const ordered = freshDb();
      staging(ordered);
      signing(ordered, options);
      if (!masked) {
        daily(ordered);
        expect(snapshot(ordered).contract?.value_flag).toBe('value_low');
        staging(ordered);
      }
      amendment(ordered, 1, [null, 21_000_000]);
      daily(ordered);
      expect(snapshot(ordered).contract).toMatchObject({
        value_flag: 'value_suspect',
        amount_eur: 100_000,
      });

      staging(ordered);
      amendment(ordered, 2, [null, 100]);
      daily(ordered);
      daily(ordered);
      expect(snapshot(ordered)).toEqual(snapshot(rebuilt));
      for (const db of [rebuilt, ordered]) {
        expect(
          db
            .prepare(
              'SELECT own_estimate_source, own_estimate_value, own_estimate_currency FROM contracts',
            )
            .get(),
        ).toEqual({
          own_estimate_source: 'ocds:2026-06-01',
          own_estimate_value: 100_000,
          own_estimate_currency: 'EUR',
        });
      }
    },
  );

  it('keeps legacy source fields unknown until a source publication is replayed', () => {
    const db = freshDb(true);
    db.exec(`INSERT INTO amendments (id, natural_key, unp, contract_number, document_number, published_at, source,
      value_before, value_after, value_delta, value_restated, value_treatment, currency)
      VALUES ('am:TEST-UNP:TEST-CONTRACT:ANNEX-1', 'am:TEST-UNP:TEST-CONTRACT:ANNEX-1', 'TEST-UNP', 'TEST-CONTRACT',
        'ANNEX-1', '2026-06-03', 'eop:annexes:2026-06-03', 10000, 15000, 5000, 1, 'total_restated', 'EUR')`);
    db.exec(read(`${migrationDir}/0029_contract_value_evidence.sql`));
    staging(db);
    signing(db);
    amendment(db, 2, [16_000, 17_000]);
    daily(db);
    expect(snapshot(db).contract?.value_flag).toBe('annex_total_suspect'); // legacy bounded restatement fallback
    const evidence = () =>
      db
        .prepare(
          `SELECT value_evidence_known, raw_value_after, raw_value_delta
      FROM amendments WHERE document_number = 'ANNEX-1'`,
        )
        .get();
    expect(evidence()).toEqual({
      value_evidence_known: 0,
      raw_value_after: null,
      raw_value_delta: null,
    });

    staging(db);
    amendment(db, 1, [10_000, 25_000, 15_000, 15_000, 'total_restated']);
    daily(db);
    expect(evidence()).toEqual({
      value_evidence_known: 1,
      raw_value_after: 25_000,
      raw_value_delta: 15_000,
    });
    expect(snapshot(db).contract).toMatchObject({ value_flag: 'ok', amount_eur: 17_000 });
  });

  it('reads a later annex on the exact double of a legacy unchanged restatement as inherited', () => {
    const db = freshDb(true);
    db.exec(`INSERT INTO amendments (id, natural_key, unp, contract_number, document_number, published_at, source,
      value_before, value_after, value_delta, value_restated, value_treatment, currency)
      VALUES ('am:TEST-UNP:TEST-CONTRACT:ANNEX-1', 'am:TEST-UNP:TEST-CONTRACT:ANNEX-1', 'TEST-UNP', 'TEST-CONTRACT',
        'ANNEX-1', '2026-06-03', 'eop:annexes:2026-06-03', 10000, 10000, 0, 1, 'unchanged_restated', 'EUR')`);
    db.exec(read(`${migrationDir}/0029_contract_value_evidence.sql`));
    staging(db);
    signing(db);
    amendment(db, 2, [20_000, 20_000]);
    daily(db);
    expect(snapshot(db).contract).toMatchObject({
      value_flag: 'annex_total_suspect',
      amount_eur: 10_000,
    });

    // The replayed source publication confirms it through the raw total.
    staging(db);
    amendment(db, 1, [10_000, 20_000, 10_000, 10_000, 'unchanged_restated']);
    daily(db);
    expect(snapshot(db).contract).toMatchObject({
      value_flag: 'annex_total_suspect',
      amount_eur: 10_000,
    });
  });

  it('carries only the established symbolic verdict for an older contract without its estimate', () => {
    const db = freshDb();
    staging(db);
    signing(db, { signing: 1, currency: 'BGN' });
    daily(db);
    db.exec(
      'UPDATE contracts SET own_estimate_source = NULL, own_estimate_value = NULL, own_estimate_currency = NULL',
    );

    staging(db);
    amendment(db, 1, [null, 21_000_000]);
    daily(db);
    expect(snapshot(db).contract?.value_flag).toBe('value_suspect');

    staging(db);
    amendment(db, 2, [null, 100]);
    daily(db);
    expect(snapshot(db).contract).toMatchObject({ value_flag: 'value_low', amount_eur: 100 });
    expect(
      db
        .prepare(
          'SELECT own_estimate_source, own_estimate_value, own_estimate_currency FROM contracts',
        )
        .get(),
    ).toEqual({
      own_estimate_source: 'legacy:value_low',
      own_estimate_value: null,
      own_estimate_currency: null,
    });
  });

  it('retains a served contract through replay if a later anomaly has no procedure estimate', () => {
    const existing = freshDb();
    const options = { own: null, procedure: null };
    staging(existing);
    signing(existing, options);
    daily(existing);
    staging(existing);
    amendment(existing, 1, [null, 2_100_000_000]);
    daily(existing);
    expect(snapshot(existing).contract).toMatchObject({
      amount: 10_000,
      amount_eur: null,
      value_flag: 'value_suspect',
    });

    const initial = freshDb();
    for (const db of [existing, initial]) {
      staging(db);
      signing(db, options);
      amendment(db, 1, [null, 2_100_000_000]);
      daily(db);
    }
    expect(existing.prepare('SELECT COUNT(*) AS n FROM contracts').get()?.n).toBe(1);
    expect(snapshot(existing).contract).toMatchObject({
      amount: 10_000,
      amount_eur: null,
      value_flag: 'value_suspect',
    });
    expect(initial.prepare('SELECT COUNT(*) AS n FROM contracts').get()?.n).toBe(0);
    full(initial);
    expect(initial.prepare('SELECT COUNT(*) AS n FROM contracts').get()?.n).toBe(0);
  });

  it.each(['full', 'one window', 'annex-only'])(
    'agrees with detail and CSV for the USD coincidence (%s)',
    async (mode) => {
      const db = freshDb();
      staging(db);
      signing(db);
      if (mode === 'annex-only') {
        daily(db);
        staging(db);
      }
      db.exec("INSERT INTO fx_rates VALUES ('USD', '2026-06-01', 0.8, 'test', '2026-06-01')");
      amendment(db, 1, [20_000, 31_293.28, null, undefined, undefined, 'USD']);
      amendment(db, 2, [16_000, 35_000]);
      (mode === 'full' ? full : daily)(db);
      const d1 = d1FromSqlite(db);
      const id = String(db.prepare('SELECT id FROM contracts').get()?.id);
      const detail = await getContract(d1, id);
      expect(detail?.value).toMatchObject({ flag: 'ok', signingEur: 10_000, currentEur: 35_000 });
      expect(detail?.amendments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentNumber: 'ANNEX-2',
            suspect: false,
            valueAfterEur: 35_000,
            deltaEur: 19_000,
          }),
        ]),
      );
      expect(await streamContractsCsv(d1, {}).text()).toMatch(/,35000,[^\n]*,ok\r?\n/);
    },
  );

  it('uses the preferred source for the public annex verdict', () => {
    for (const run of [full, daily]) {
      const db = freshDb();
      staging(db);
      signing(db);
      db.exec(`INSERT INTO raw_contracts (source, fetched_at, unp, authority_eik, authority_name,
          contract_number, signing_value, currency, contract_date, contractor_name)
        VALUES ('eop:contracts:2026-06-01', '2026-06-01', 'TEST-UNP', 'TEST-ORG', 'Test Authority',
          'TEST-CONTRACT', 15000, 'EUR', '2026-06-02', 'Test Supplier')`);
      amendment(db, 1, [10_000, 25_000]);
      run(db);
      expect(snapshot(db).contract).toMatchObject({ signing_value: 15_000, value_flag: 'ok' });
      expect(db.prepare('SELECT value_suspect FROM amendments').get()?.value_suspect).toBe(0);
    }
  });

  it('marks an earlier doubled row without flagging a different leading annex with the same after-value', () => {
    const db = freshDb();
    staging(db);
    signing(db);
    daily(db);
    staging(db);
    amendment(db, 1, [10_000, 20_000]);
    amendment(db, 2, [19_000, 20_000]);
    daily(db);
    expect(snapshot(db).contract).toMatchObject({ amount_eur: 20_000, value_flag: 'ok' });
    expect(
      db.prepare('SELECT value_suspect FROM amendments ORDER BY document_number').all(),
    ).toEqual([{ value_suspect: 1 }, { value_suspect: 0 }]);
  });
});
