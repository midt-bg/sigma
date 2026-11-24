import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { mapBaseRecord } from './base';
import { releaseToContracts, releaseToParties, type OcdsRelease } from './ocds';
import { dropTransientStagingStatements, refreshSliceStatementGroups } from './refresh';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const scripts = (name: string) => read(`scripts/${name}.sql`);
const groups = refreshSliceStatementGroups(scripts('refresh-slice'));
const migrations = readdirSync(resolve(root, 'packages/db/migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const handles: DatabaseSync[] = [];
const days = ['2026-06-01', '2026-06-02', '2026-06-03'] as const;
const ocid = 'ocds-test-procedure';
const legacy = 'auth:TEST-ORG';
const scoped = `ocds-auth:${Buffer.from(ocid).toString('hex')}`;
const eop = 'auth:TEST-EOP';
const tenderId = `t:${ocid}`;

function open() {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  for (const file of migrations) db.exec(read(`packages/db/migrations/${file}`));
  stage(db);
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

function stage(db: DatabaseSync) {
  db.exec(dropTransientStagingStatements().join(';'));
  db.exec(scripts('work-staging-schema'));
}

function insert(db: DatabaseSync, table: string, rows: object[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...(Object.values(row) as SQLInputValue[]));
  }
}

function stageRelease(db: DatabaseSync, day: string, release: OcdsRelease) {
  const meta = {
    source: `ocds:${day}`,
    fetchedAt: day,
    year: 2026,
    datasetUri: null,
    resourceUri: null,
  };
  const parties = releaseToParties(release, meta);
  insert(db, 'raw_ocds_parties', parties);
  insert(db, 'raw_contracts', releaseToContracts(release, meta));
  return parties[0]?.appearance;
}

function signing(
  db: DatabaseSync,
  day: string,
  {
    procedure = ocid,
    ref = 'BUYER-1',
    name = 'Тестов възложител',
    mixed = false,
    amount = 10_000,
    hasContract = amount !== null,
    document = `C-${procedure}`,
  }: {
    procedure?: string;
    ref?: string;
    name?: string;
    mixed?: boolean;
    amount?: number | null;
    hasContract?: boolean;
    document?: string;
  } = {},
) {
  return stageRelease(db, day, {
    ocid: procedure,
    id: `DOC-${procedure}`,
    date: day,
    tag: ['contract'],
    buyer: { id: ref, name },
    parties: [
      {
        id: ref,
        name,
        identifier: { id: 'TEST-ORG' },
        roles: mixed ? ['buyer', 'supplier'] : ['buyer'],
      },
      { id: 'SELLER', name: 'Тестов изпълнител', roles: ['supplier'] },
    ],
    tender: { title: 'Тестова доставка', value: { amount: 50_000, currency: 'EUR' } },
    awards: [{ id: 'AWARD', suppliers: [{ id: 'SELLER' }] }],
    contracts: hasContract
      ? [
          {
            id: document,
            awardID: 'AWARD',
            dateSigned: days[0],
            value: amount === null ? undefined : { amount, currency: 'EUR' },
          },
        ]
      : [],
  });
}

function full(db: DatabaseSync) {
  for (const script of [
    'resolve-amendment-contracts',
    'derive-amendments',
    'normalize-raw',
    'promote-amendments',
    'precompute',
  ]) {
    db.exec(scripts(script));
  }
}

function slice(db: DatabaseSync, stopAfter?: string) {
  for (const group of groups) {
    db.exec('BEGIN');
    try {
      for (const sql of group.statements) db.exec(sql);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (group.name === stopAfter) return;
  }
}

const binding = (db: DatabaseSync) =>
  db
    .prepare('SELECT appearance, authority_id, source FROM ocds_tender_buyers WHERE tender_id = ?')
    .get(tenderId);
const authority = (db: DatabaseSync) =>
  db.prepare('SELECT authority_id FROM tenders WHERE id = ?').get(tenderId)?.authority_id;

function reconcile(db: DatabaseSync, expected: Array<[string, number]>) {
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(
    db
      .prepare(
        'SELECT authority_id, SUM(won_eur) AS spent_eur FROM flow_pairs GROUP BY authority_id ORDER BY authority_id',
      )
      .all(),
  ).toEqual(expected.map(([authority_id, spent_eur]) => ({ authority_id, spent_eur })));
  expect(
    db.prepare('SELECT authority_id, spent_eur FROM authority_totals ORDER BY authority_id').all(),
  ).toEqual(expected.map(([authority_id, spent_eur]) => ({ authority_id, spent_eur })));
  const sum = expected.reduce((total, [, amount]) => total + amount, 0);
  for (const [table, column] of [
    ['contracts', 'amount_eur'],
    ['home_totals', 'value_eur'],
    ['company_totals', 'won_eur'],
    ['flow_pairs', 'won_eur'],
  ]) {
    expect(db.prepare(`SELECT SUM(${column}) AS total FROM ${table}`).get()?.total).toBe(sum);
  }
}

describe('OCDS buyer attribution', () => {
  it.each(['full', 'chronological', 'reverse'])(
    'uses the most recent signing appearance in %s',
    (mode) => {
      const db = open();
      let appearance: string | null | undefined;
      for (const index of mode === 'reverse'
        ? [2, 1, 0, 0]
        : mode === 'full'
          ? [0, 1, 2]
          : [0, 1, 2, 0]) {
        if (mode !== 'full') stage(db);
        if (index === 0) signing(db, days[0]);
        if (index === 1)
          appearance = signing(db, days[1], { ref: 'BUYER-2', document: 'C-SECOND' });
        if (index === 2) signing(db, days[2], { ref: 'BUYER-2', mixed: true, amount: null });
        if (mode !== 'full') slice(db);
        if (mode === 'chronological' && index === 1) {
          expect(binding(db)).toEqual({
            appearance,
            authority_id: legacy,
            source: `ocds:${days[1]}`,
          });
        }
      }
      if (mode === 'full') full(db);
      expect(binding(db)).toEqual({ appearance, authority_id: scoped, source: `ocds:${days[1]}` });
      expect(authority(db)).toBe(scoped);
      reconcile(db, [[scoped, 20_000]]);
    },
  );

  it.each(['full', 'chronological', 'reverse'])(
    'ignores a newer distinct signing with missing value in %s',
    (mode) => {
      const db = open();
      const first = () => signing(db, days[0]);
      const later = () =>
        signing(db, days[1], {
          ref: 'BUYER-2',
          mixed: true,
          document: 'C-SECOND',
          amount: null,
          hasContract: true,
        });
      let appearance: string | null | undefined;
      if (mode === 'full') {
        appearance = first();
        later();
        full(db);
      } else if (mode === 'chronological') {
        appearance = first();
        slice(db);
        stage(db);
        later();
        slice(db);
      } else {
        later();
        slice(db);
        expect(binding(db)).toBeUndefined();
        expect(db.prepare('SELECT * FROM synthetic_tenders_awaiting_buyer').all()).toEqual([
          { tender_id: tenderId },
        ]);
        stage(db);
        appearance = first();
        slice(db);
      }
      expect(binding(db)).toEqual({ appearance, authority_id: legacy, source: `ocds:${days[0]}` });
      expect(authority(db)).toBe(legacy);
      expect(
        db.prepare('SELECT tender_id, contract_number, amount_eur FROM contracts').all(),
      ).toEqual([{ tender_id: tenderId, contract_number: `C-${ocid}`, amount_eur: 10_000 }]);
      expect(db.prepare('SELECT * FROM synthetic_tenders_awaiting_buyer').all()).toEqual([]);
      reconcile(db, [[legacy, 10_000]]);

      stage(db);
      signing(db, days[0]);
      slice(db);
      expect(binding(db)?.appearance).toBe(appearance);
      reconcile(db, [[legacy, 10_000]]);
    },
  );

  it.each([
    { amount: 0, published: 0, flag: 'value_low' },
    { amount: 5_000_000, published: 50_000, flag: 'value_suspect' },
    { amount: 12_000, published: 12_000, flag: 'ok' },
  ])('selects a newer signing with a served value of $published', ({ amount, published, flag }) => {
    for (const mode of ['full', 'chronological']) {
      const db = open();
      signing(db, days[0]);
      if (mode === 'chronological') {
        slice(db);
        stage(db);
      }
      const appearance = signing(db, days[1], {
        ref: 'BUYER-2',
        mixed: true,
        document: 'C-SECOND',
        amount,
      });
      if (mode === 'full') full(db);
      else slice(db);
      expect(binding(db)).toEqual({ appearance, authority_id: scoped, source: `ocds:${days[1]}` });
      expect(authority(db)).toBe(scoped);
      expect(
        db
          .prepare(
            "SELECT tender_id, amount_eur, value_flag FROM contracts WHERE contract_number = 'C-SECOND'",
          )
          .get(),
      ).toEqual({ tender_id: tenderId, amount_eur: published, value_flag: flag });
      reconcile(db, [[scoped, 10_000 + published]]);
      stage(db);
      signing(db, days[0]);
      slice(db);
      expect(binding(db)?.appearance).toBe(appearance);
      reconcile(db, [[scoped, 10_000 + published]]);
    }
  });

  it('uses the daily same-document retention decision and full rebuild valuation independently', () => {
    const daily = open();
    const cumulative = open();
    const first = signing(cumulative, days[0]);
    signing(daily, days[0]);
    for (const db of [daily, cumulative])
      signing(db, days[0], { document: 'C-OTHER', amount: 20_000 });
    slice(daily);
    stage(daily);
    const later = { ref: 'BUYER-2', mixed: true, amount: null, hasContract: true };
    const retained = signing(daily, days[1], later);
    signing(cumulative, days[1], later);
    full(cumulative);
    slice(daily, 'contracts');
    expect(binding(daily)).toEqual({
      appearance: retained,
      authority_id: scoped,
      source: `ocds:${days[1]}`,
    });
    expect(
      daily
        .prepare('SELECT tender_id, amount, amount_eur FROM contracts WHERE contract_number = ?')
        .all(`C-${ocid}`),
    ).toEqual([{ tender_id: tenderId, amount: 10_000, amount_eur: null }]);
    expect(daily.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // Re-run the committed publication and complete the rollups.
    slice(daily);
    expect(binding(daily)?.appearance).toBe(retained);
    expect(authority(daily)).toBe(scoped);
    expect(
      daily
        .prepare('SELECT tender_id, amount, amount_eur FROM contracts WHERE contract_number = ?')
        .all(`C-${ocid}`),
    ).toEqual([{ tender_id: tenderId, amount: 10_000, amount_eur: null }]);
    reconcile(daily, [[scoped, 20_000]]);
    expect(binding(cumulative)?.appearance).toBe(first);
    expect(authority(cumulative)).toBe(legacy);
    reconcile(cumulative, [[legacy, 30_000]]);
  });

  it.each(['distinct document', 'replaces one document'])(
    'keeps the existing buyer if a shared-key EOP signing has no value (%s)',
    (mode) => {
      for (const cumulative of [true, false]) {
        const db = open();
        const first = signing(db, days[0]);
        if (mode === 'replaces one document') signing(db, days[0], { document: 'C-EOP' });
        if (!cumulative) {
          slice(db);
          stage(db);
        }
        insert(db, 'raw_contracts', [
          {
            source: `eop:contracts:${days[1]}`,
            fetched_at: days[1],
            unp: ocid,
            authority_eik: 'TEST-EOP',
            authority_name: 'Тестов възложител ЕОП',
            contract_number: 'C-EOP',
            contract_date: days[0],
            currency: 'EUR',
            contractor_name: 'Тестов изпълнител',
          },
        ]);
        if (cumulative) full(db);
        else slice(db);
        expect(binding(db)).toEqual({
          appearance: first,
          authority_id: legacy,
          source: `ocds:${days[0]}`,
        });
        expect(authority(db)).toBe(legacy);
        expect(db.prepare('SELECT tender_id, contract_number FROM contracts').all()).toEqual([
          { tender_id: tenderId, contract_number: `C-${ocid}` },
        ]);
        reconcile(db, [[legacy, 10_000]]);
      }
    },
  );

  it('clears a pending synthetic buyer when an EOP header is published', () => {
    const db = open();
    signing(db, days[0], { amount: null, hasContract: true });
    slice(db);
    expect(db.prepare('SELECT * FROM synthetic_tenders_awaiting_buyer').all()).toEqual([
      { tender_id: tenderId },
    ]);
    stage(db);
    insert(db, 'raw_tenders', [
      {
        source: `eop:tenders:${days[1]}`,
        fetched_at: days[1],
        unp: ocid,
        tender_id: '31415',
        authority_eik: 'TEST-EOP',
        authority_name: 'Тестов възложител ЕОП',
      },
    ]);
    slice(db, 'tenders');
    expect(db.prepare('SELECT * FROM synthetic_tenders_awaiting_buyer').all()).toEqual([]);
    stage(db);
    signing(db, days[2], { ref: 'BUYER-2', mixed: true });
    slice(db);
    expect(binding(db)).toBeUndefined();
    expect(authority(db)).toBe(eop);
    reconcile(db, [[eop, 10_000]]);
  });

  it('reselects the surviving buyer when an EOP contract replaces the selected signing by number', () => {
    const eopUnp = '99999-2026-0001';
    const doc = 'C-SECOND';
    const bidder = 'name:ТЕСТОВ ИЗПЪЛНИТЕЛ';
    const originalId = `c:o:${ocid}:C-${ocid}:_:${bidder}:1`;
    const removedId = `c:o:${ocid}:${doc}:_:${bidder}:1`;
    const replacementId = `c:e:${eopUnp}:${doc}:_:${bidder}:1`;
    const replacement = mapBaseRecord(
      'contracts',
      {
        uniqueProcurementNumber: eopUnp,
        contractNumber: doc,
        contractDate: days[1],
        contractValue: 12_000,
        contractCurrency: 'EUR',
        buyerRegistryNumber: 'TEST-EOP',
        buyerName: 'Тестов възложител ЕОП',
        supplierName: 'Тестов изпълнител',
      },
      { day: days[2], fetchedAt: days[2] },
    );
    expect(replacement?.unp).toBe(eopUnp);
    if (!replacement) throw new Error('missing EOP fixture row');

    for (const cumulative of [true, false]) {
      const db = open();
      const first = signing(db, days[0]);
      if (!cumulative) {
        slice(db);
        stage(db);
      }
      const latest = signing(db, days[1], {
        ref: 'BUYER-2',
        mixed: true,
        document: doc,
        amount: 12_000,
      });
      if (!cumulative) {
        slice(db);
        expect(binding(db)).toEqual({
          appearance: latest,
          authority_id: scoped,
          source: `ocds:${days[1]}`,
        });
        reconcile(db, [[scoped, 22_000]]);
        stage(db);
      }
      insert(db, 'raw_contracts', [replacement]);
      if (cumulative) full(db);
      else {
        slice(db, 'contracts');
        expect(db.prepare('SELECT id FROM refresh_touched_contracts ORDER BY id').all()).toEqual(
          [replacementId, removedId, originalId].sort().map((id) => ({ id })),
        );
        expect(
          db
            .prepare('SELECT authority_id FROM refresh_touched_authorities ORDER BY authority_id')
            .all(),
        ).toEqual([eop, legacy, scoped].sort().map((authority_id) => ({ authority_id })));
        expect(db.prepare('SELECT bidder_id FROM refresh_touched_bidders').all()).toEqual([
          { bidder_id: bidder },
        ]);
        stage(db);
        slice(db);
        stage(db);
        signing(db, days[0]);
        slice(db);
      }

      expect(
        db.prepare('SELECT id, tender_id, amount, amount_eur FROM contracts ORDER BY id').all(),
      ).toEqual([
        { id: replacementId, tender_id: `t:${eopUnp}`, amount: 12_000, amount_eur: 12_000 },
        { id: originalId, tender_id: tenderId, amount: 10_000, amount_eur: 10_000 },
      ]);
      expect(binding(db)).toEqual({
        appearance: first,
        authority_id: legacy,
        source: `ocds:${days[0]}`,
      });
      expect(db.prepare('SELECT * FROM ocds_contract_buyers').all()).toEqual([
        {
          contract_id: originalId,
          appearance: first,
          authority_id: legacy,
          source: `ocds:${days[0]}`,
        },
      ]);
      expect(
        db
          .prepare("SELECT ref, amount FROM search_index WHERE kind = 'authority' ORDER BY ref")
          .all(),
      ).toEqual([
        { ref: eop, amount: 12_000 },
        { ref: legacy, amount: 10_000 },
      ]);
      reconcile(db, [
        [eop, 12_000],
        [legacy, 10_000],
      ]);
    }
  });

  it('updates the buyer binding when an existing signing reappears with a different reference', () => {
    const db = open();
    signing(db, days[0]);
    slice(db);
    stage(db);
    const appearance = signing(db, days[1], { ref: 'BUYER-2' });
    slice(db);
    expect(binding(db)).toEqual({ appearance, authority_id: legacy, source: `ocds:${days[1]}` });
    stage(db);
    signing(db, days[0]);
    slice(db);
    expect(binding(db)?.appearance).toBe(appearance);
    stage(db);
    signing(db, days[2], { ref: 'BUYER-2', mixed: true, amount: null });
    slice(db);
    expect(authority(db)).toBe(scoped);
    reconcile(db, [[scoped, 10_000]]);
  });

  it.each([false, true])(
    'resumes an empty window after publishing a role-only move (independent buyer: %s)',
    (independent) => {
      const db = open();
      signing(db, days[0]);
      if (independent)
        signing(db, days[0], { procedure: 'ocds-test-independent', ref: 'OTHER', amount: 20_000 });
      full(db);
      stage(db);
      signing(db, days[1], { mixed: true, amount: null });
      slice(db, 'ocds-publication');
      expect(authority(db)).toBe(scoped);
      expect(
        db
          .prepare('SELECT authority_id FROM refresh_touched_authorities ORDER BY authority_id')
          .all(),
      ).toEqual([{ authority_id: legacy }, { authority_id: scoped }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_touched_contracts').get()?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_touched_bidders').get()?.n).toBe(1);
      stage(db);
      slice(db);
      reconcile(
        db,
        independent
          ? [
              [legacy, 20_000],
              [scoped, 10_000],
            ]
          : [[scoped, 10_000]],
      );
      expect(db.prepare('SELECT id FROM authorities WHERE id = ?').get(legacy) != null).toBe(
        independent,
      );
      expect(
        db
          .prepare("SELECT ident, amount FROM search_index WHERE kind = 'authority' AND ref = ?")
          .get(scoped),
      ).toEqual({ ident: '', amount: 10_000 });
    },
  );

  it.each(['shared header', 'shared contract', 'distinct UNP'])(
    'keeps EOP attribution after %s takeover',
    (kind) => {
      const unp = kind === 'distinct UNP' ? '99000-2026-0001' : ocid;
      const stageEop = (db: DatabaseSync) => {
        const common = {
          fetched_at: days[1],
          unp,
          authority_eik: 'TEST-EOP',
          authority_name: 'Тестов възложител ЕОП',
          currency: 'EUR',
        };
        if (kind !== 'shared contract') {
          insert(db, 'raw_tenders', [
            { ...common, source: `eop:tenders:${days[1]}`, tender_id: '31415' },
          ]);
        }
        if (kind !== 'shared header') {
          insert(db, 'raw_contracts', [
            {
              ...common,
              source: `eop:contracts:${days[1]}`,
              contract_number: `C-${ocid}`,
              contract_date: days[0],
              signing_value: 10_000,
              contractor_name: 'Тестов изпълнител',
            },
          ]);
        }
      };
      const cumulative = open();
      signing(cumulative, days[0]);
      stageEop(cumulative);
      signing(cumulative, days[2], { mixed: true, amount: null });
      full(cumulative);
      reconcile(cumulative, [[eop, 10_000]]);
      for (const reverse of [false, true]) {
        const db = open();
        const packets = [
          () => signing(db, days[0]),
          () => stageEop(db),
          () => signing(db, days[2], { mixed: true, amount: null }),
        ];
        for (const packet of reverse ? [...packets].reverse() : packets) {
          stage(db);
          packet();
          slice(db);
        }
        if (kind !== 'distinct UNP') {
          expect(binding(db)).toBeUndefined();
          expect(authority(db)).toBe(eop);
        }
        stage(db);
        signing(db, days[0]);
        slice(db);
        reconcile(db, [[eop, 10_000]]);
      }
    },
  );
});

it.each(['full', 'chronological', 'reverse'])(
  'merges scoped display names, blanks and fallback in %s',
  (mode) => {
    const db = open();
    const names = [' ', 'Test Zeta Buyer', 'Test Alpha Buyer агенция'];
    const order = mode === 'reverse' ? [2, 1, 0, 1] : mode === 'full' ? [0, 1, 2] : [0, 1, 2, 0];
    for (const [position, index] of order.entries()) {
      if (mode !== 'full') stage(db);
      signing(db, days[index]!, { name: names[index], mixed: true, document: `C-NAME-${index}` });
      if (mode !== 'full') {
        slice(db);
        if (mode === 'chronological' && position === 0) {
          expect(db.prepare('SELECT name FROM authorities WHERE id = ?').get(scoped)?.name).toBe(
            '(без име)',
          );
        }
      }
    }
    if (mode === 'full') full(db);
    reconcile(db, [[scoped, 30_000]]);
    expect(
      db
        .prepare(
          `SELECT a.name, t.name AS total, t.type_group, s.title FROM authorities a
    JOIN authority_totals t ON t.authority_id = a.id
    JOIN search_index s ON s.ref = a.id AND s.kind = 'authority' WHERE a.id = ?`,
        )
        .get(scoped),
    ).toEqual({ name: names[2], total: names[2], type_group: 'агенция', title: names[2] });
  },
);

it.each(['full', 'chronological', 'reverse'])(
  'keeps one party slot across absent-identifier role changes in %s',
  (mode) => {
    const db = open();
    const reference = 'PARTY-1';
    const key = `ocds-ref:${JSON.stringify([ocid, reference])}`;
    for (const index of mode === 'reverse' ? [1, 0, 0] : [0, 1, 0]) {
      if (mode !== 'full') stage(db);
      stageRelease(db, days[index]!, {
        ocid,
        parties: [
          {
            id: reference,
            name: index ? 'Test Alpha' : 'Test Zeta',
            roles: [index ? 'supplier' : 'tenderer'],
          },
          {
            id: 'UNVERIFIED',
            name: 'Test Other',
            identifier: { id: 'TEST-SUPPLIER' },
            roles: ['supplier'],
          },
          {
            id: 'VALID',
            name: 'Test Registered',
            identifier: { id: '123456786' },
            roles: ['supplier'],
          },
        ],
      });
      if (mode !== 'full') {
        slice(db);
        expect(
          db.prepare('SELECT party_key, eik FROM parties WHERE party_id = ?').all(reference),
        ).toEqual([{ party_key: key, eik: null }]);
      }
    }
    if (mode === 'full') full(db);
    expect(
      db
        .prepare('SELECT party_key, eik, source, name FROM parties WHERE party_id = ?')
        .all(reference),
    ).toEqual([{ party_key: key, eik: null, source: `ocds:${days[1]}`, name: 'Test Alpha' }]);
    expect(
      db
        .prepare('SELECT party_id, eik FROM parties WHERE party_id <> ? ORDER BY party_id')
        .all(reference),
    ).toEqual([
      { party_id: 'UNVERIFIED', eik: null },
      { party_id: 'VALID', eik: '123456786' },
    ]);
  },
);

it('carries a newer legacy party row into the absent-identifier slot on older replay', () => {
  const db = open();
  const reference = 'PARTY-1';
  insert(db, 'parties', [
    {
      party_key: `ocid:${ocid}:party:${reference}`,
      source: `ocds:${days[1]}`,
      ocid,
      party_id: reference,
      name: 'Test Newer Party',
    },
  ]);
  stageRelease(db, days[0], {
    ocid,
    parties: [{ id: reference, name: 'Test Older Party', roles: ['supplier'] }],
  });
  slice(db);
  expect(db.prepare('SELECT party_key, source, eik, name FROM parties').all()).toEqual([
    {
      party_key: `ocds-ref:${JSON.stringify([ocid, reference])}`,
      source: `ocds:${days[1]}`,
      name: 'Test Newer Party',
      eik: null,
    },
  ]);
});
