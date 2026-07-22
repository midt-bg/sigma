/// <reference types="node" />
// Legacy-NULL FX backfill (#158 follow-up): contracts derived during the bug window (cron ran the
// derive with an empty fx_rates) sit in the SERVED D1 with amount_eur = NULL — and, subtler, with
// value_flag mis-assigned (eff_eur was NULL, so value_suspect/review classification fell through
// to 'ok'). scripts/backfill-fx.mjs repairs the served rows in place and refreshes the rollups
// through refresh-slice.sql's own touched-scoped batches.
//
// The crown test is EQUIVALENCE: ground truth = the real derive WITH rates present; damaged twin =
// the same corpus derived WITHOUT rates, then backfilled with the same rates. Every EUR column,
// every flag, and every rollup table must come out identical — that is what makes the backfill's
// repair SQL drift-proof against scripts/refresh-slice.sql.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { backfillFx, repairSql, reportFxDamage } from '../../../scripts/backfill-fx.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const initSql = readFileSync(resolve(root, 'packages/db/migrations/0000_init.sql'), 'utf8');
const flowIdxSql = readFileSync(
  resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql'),
  'utf8',
);
const stagingSql = readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8');
const refreshSliceSql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');

const FETCHED_AT = '2026-07-22T00:00:00Z';
const SIGNED = '2026-05-20';
// ECB business days only — no rate ON the signing date, the derive carries 05-19 forward.
const USD_RATES: Record<string, { EUR: number }> = {
  '2026-05-16': { EUR: 0.88 },
  '2026-05-19': { EUR: 0.9 },
};
const USD_RATE = 0.9;
const PEG = 1.95583;

interface Contract {
  unp: string;
  num: string;
  value: number;
  ccy: string;
  estimate?: number;
  estCcy?: string;
}

// One tender + one contract per row; SUSP/REV exercise the flag re-classification the bug window
// got wrong, ANNEX exercises the amendments/current_value path, CHF stays unpricable end to end.
const CORPUS: Contract[] = [
  { unp: 'UNP-OK', num: 'C-USD-OK', value: 100000, ccy: 'USD' },
  { unp: 'UNP-BGN', num: 'C-BGN', value: 1000, ccy: 'BGN' },
  { unp: 'UNP-EUR', num: 'C-EUR', value: 2500, ccy: 'EUR' },
  {
    unp: 'UNP-SUSP',
    num: 'C-USD-SUSP',
    value: 3000000,
    ccy: 'USD',
    estimate: 10000,
    estCcy: 'BGN',
  },
  { unp: 'UNP-REV', num: 'C-USD-REV', value: 60000, ccy: 'USD', estimate: 5000, estCcy: 'EUR' },
  { unp: 'UNP-CHF', num: 'C-CHF-UNPRICED', value: 5000, ccy: 'CHF' },
  { unp: 'UNP-ANNEX', num: 'C-USD-ANNEX', value: 10000, ccy: 'USD' },
];

function seedCorpus(db: DatabaseSync): void {
  db.exec(initSql);
  db.exec(flowIdxSql);
  db.exec(stagingSql);
  for (const c of CORPUS) {
    db.prepare(
      `INSERT INTO raw_tenders
        (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
         cpv_code, contract_kind, estimated_value, currency, authority_name, authority_eik,
         authority_type, num_lots, published_at)
       VALUES ('eop:tenders:2026-06-01', 2026, ?, ?, ?, 'open', 'Backfill tender', '45000000',
               'works', ?, ?, 'Authority BF', '123456789', 'public', 1, '2026-05-15')`,
    ).run(FETCHED_AT, c.unp, `T-${c.unp}`, c.estimate ?? null, c.estCcy ?? 'BGN');
    db.prepare(
      `INSERT INTO raw_contracts
        (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
         published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
         contract_kind, estimated_value, procurement_currency, authority_name, authority_eik,
         authority_type, contract_number, contract_date, signing_value, currency,
         contract_subject, contractor_eik, contractor_name, contractor_country, bids_received)
       VALUES ('eop:contracts:2026-06-01', 2026, 'eop', ?, 0, ?, '2026-06-01', ?, ?, 'open',
               'Backfill tender', '45000000', 'works', NULL, NULL, 'Authority BF', '123456789',
               'public', ?, ?, ?, ?, 'Backfill contract', '987654321', 'Bidder BF', 'BG', 3)`,
    ).run(FETCHED_AT, `DOC-${c.num}`, c.unp, `T-${c.unp}`, c.num, SIGNED, c.value, c.ccy);
  }
  // Annex on C-USD-ANNEX: current_value moves 10000 → 12000 in USD.
  db.prepare(
    `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
       contract_number, contract_date, published_at, unp, authority_eik, authority_name,
       procurement_subject, contract_kind, value_before, value_after, value_delta, currency,
       description)
     VALUES ('eop:annexes:2026-06-01', 2026, 'eop', ?, '1', 'AMD-ANNEX-1', 'C-USD-ANNEX', ?,
             '2026-06-01', 'UNP-ANNEX', '123456789', 'Authority BF', 'Backfill tender', 'works',
             10000, 12000, 2000, 'USD', 'Increase')`,
  ).run(FETCHED_AT, SIGNED);
}

function insertUsdRates(db: DatabaseSync): void {
  for (const [date, { EUR }] of Object.entries(USD_RATES)) {
    db.prepare(
      'INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES (?, ?, ?, ?, ?)',
    ).run('USD', date, EUR, 'ecb:frankfurter', FETCHED_AT);
  }
}

function derive(db: DatabaseSync): void {
  db.exec(refreshSliceSql);
}

function dropStaging(db: DatabaseSync): void {
  for (const t of [
    'raw_contracts',
    'raw_tenders',
    'raw_amendments',
    'raw_ocds_parties',
    'raw_ocds_lots',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}

function groundTruthDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  seedCorpus(db);
  insertUsdRates(db);
  derive(db);
  return db;
}

function damagedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  seedCorpus(db);
  derive(db); // no rates: the bug-window derive
  dropStaging(db); // the served D1 carries no raw staging
  return db;
}

function runnerFor(db: DatabaseSync) {
  return {
    query: (sql: string) => db.prepare(sql).all() as Record<string, unknown>[],
    exec: (sql: string) => {
      db.exec(sql);
    },
  };
}

function fxFetchMock(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get('base') === 'USD') {
      return new Response(JSON.stringify({ rates: USD_RATES }), { status: 200 });
    }
    // CHF (and anything else): frankfurter does not serve it.
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

async function backfill(db: DatabaseSync) {
  return backfillFx(runnerFor(db), {
    fetchFn: fxFetchMock(),
    fetchedAt: FETCHED_AT,
    refreshSliceSql,
  });
}

const CONTRACT_COLS =
  'contract_number, amount, currency, value_flag, amount_eur, fx_converted, fx_rate, signing_value_eur, current_value_eur';
const ROLLUP_QUERIES = {
  contracts: `SELECT ${CONTRACT_COLS} FROM contracts ORDER BY contract_number`,
  company_totals:
    'SELECT bidder_id, name, won_eur, contracts, authorities, first_date, last_date FROM company_totals ORDER BY bidder_id',
  authority_totals:
    'SELECT authority_id, name, spent_eur, contracts, suppliers, avg_eur, first_date, last_date FROM authority_totals ORDER BY authority_id',
  flow_pairs:
    'SELECT authority_id, bidder_id, won_eur, contracts FROM flow_pairs ORDER BY authority_id, bidder_id',
  home_totals:
    'SELECT contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of FROM home_totals',
  sector_totals: 'SELECT division, contracts, value_eur FROM sector_totals ORDER BY division',
  facet_counts: 'SELECT facet, key, contracts, value_eur FROM facet_counts ORDER BY facet, key',
  search_index:
    "SELECT kind, ref, title, ident, amount FROM search_index WHERE kind IN ('contract','company','authority') ORDER BY kind, ref",
  data_freshness: 'SELECT source, as_of, rows FROM data_freshness ORDER BY source',
};

describe('legacy-NULL FX damage (bug-window derive)', () => {
  it('reproduces: foreign rows derive NULL amount_eur and mis-classify as ok', () => {
    const db = damagedDb();
    const rows = db
      .prepare(
        "SELECT contract_number, value_flag, amount_eur FROM contracts WHERE currency NOT IN ('BGN','EUR') ORDER BY contract_number",
      )
      .all() as { contract_number: string; value_flag: string; amount_eur: number | null }[];
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.amount_eur).toBeNull();
      // The dangerous part: even the 300x-estimate contract classified 'ok' with no rate to price it.
      expect(r.value_flag).toBe('ok');
    }
    const bgn = db
      .prepare("SELECT amount_eur FROM contracts WHERE contract_number = 'C-BGN'")
      .get() as { amount_eur: number };
    expect(bgn.amount_eur).toBeCloseTo(1000 / PEG, 6);
  });

  it('ground truth: the same corpus derived with rates prices and flags correctly', () => {
    const db = groundTruthDb();
    const flag = (num: string) =>
      db
        .prepare('SELECT value_flag, amount_eur FROM contracts WHERE contract_number = ?')
        .get(num) as {
        value_flag: string;
        amount_eur: number | null;
      };
    expect(flag('C-USD-OK')).toEqual({ value_flag: 'ok', amount_eur: 100000 * USD_RATE });
    expect(flag('C-USD-SUSP').value_flag).toBe('value_suspect');
    expect(flag('C-USD-SUSP').amount_eur).toBeCloseTo(10000 / PEG, 4);
    expect(flag('C-USD-REV')).toEqual({ value_flag: 'review', amount_eur: 60000 * USD_RATE });
    expect(flag('C-USD-ANNEX').amount_eur).toBeCloseTo(12000 * USD_RATE, 6);
    expect(flag('C-CHF-UNPRICED').amount_eur).toBeNull();
  });
});

describe('backfillFx', () => {
  it('reports the damage before repairing', () => {
    const db = damagedDb();
    const report = reportFxDamage(runnerFor(db));
    expect(report.total).toBe(5);
    expect(report.byCurrency).toEqual({ CHF: 1, USD: 4 });
  });

  it('EQUIVALENCE: backfilled damaged DB matches the with-rates derive on every surface', async () => {
    const truth = groundTruthDb();
    const db = damagedDb();

    const summary = await backfill(db);
    expect(summary.repaired).toBe(4);
    expect(summary.remaining.map((r) => r.currency)).toEqual(['CHF']);

    for (const [table, sql] of Object.entries(ROLLUP_QUERIES)) {
      expect(db.prepare(sql).all(), `table ${table}`).toEqual(truth.prepare(sql).all());
    }
    const rates = (d: DatabaseSync) =>
      d.prepare('SELECT base_currency, rate_date, eur_per_unit FROM fx_rates ORDER BY 1, 2').all();
    expect(rates(db)).toEqual(rates(truth));
  });

  it('is idempotent: a second run fetches nothing and changes nothing', async () => {
    const db = damagedDb();
    await backfill(db);
    const before = ROLLUP_QUERIES.contracts ? db.prepare(ROLLUP_QUERIES.contracts).all() : [];

    const fetchFn = fxFetchMock();
    const summary = await backfillFx(runnerFor(db), {
      fetchFn,
      fetchedAt: FETCHED_AT,
      refreshSliceSql,
    });
    // CHF is still damaged (unpricable) → one retry for CHF only; USD is covered, never re-fetched.
    expect(summary.repaired).toBe(0);
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      new URL(String(c[0])).searchParams.get('base'),
    );
    expect(calls).toEqual(['CHF']);
    expect(db.prepare(ROLLUP_QUERIES.contracts).all()).toEqual(before);
  });

  it('report-only mode mutates nothing', () => {
    const db = damagedDb();
    const before = db.prepare(ROLLUP_QUERIES.contracts).all();
    reportFxDamage(runnerFor(db));
    expect(db.prepare(ROLLUP_QUERIES.contracts).all()).toEqual(before);
  });

  it('fails loudly when the rate fetch fails while damage remains', async () => {
    const db = damagedDb();
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      backfillFx(runnerFor(db), { fetchFn, fetchedAt: FETCHED_AT, refreshSliceSql }),
    ).rejects.toThrow(/network down|fx/i);
  });

  it('resumes an interrupted run: heals stale rollups from the leftover touched tables', async () => {
    const truth = groundTruthDb();
    // The interrupted state: rates loaded and the row repair committed, but the process died
    // before ANY rollup group ran — refresh_touched_* linger, rollups still hold bug-window sums.
    const db = damagedDb();
    insertUsdRates(db);
    db.exec(repairSql());

    const report = reportFxDamage(runnerFor(db));
    expect(report.interrupted).toBe(true);
    // The repaired USD rows no longer match the damage predicate — without the leftover-table
    // heal, their rollup contribution would be unrecoverable (the HIGH from the security review).
    expect(report.byCurrency).toEqual({ CHF: 1 });

    const summary = await backfill(db);
    expect(summary.healed).toBe(true);
    for (const [table, sql] of Object.entries(ROLLUP_QUERIES)) {
      expect(db.prepare(sql).all(), `table ${table}`).toEqual(truth.prepare(sql).all());
    }
    // Fully healed: touched tables are gone again.
    expect(reportFxDamage(runnerFor(db)).interrupted).toBe(false);
  });

  it('heals an interrupted run even when no damaged rows remain (early-return path)', async () => {
    // With a CHF rate present the interrupted run repaired EVERY row — the next run sees zero
    // damage, and before the fix would have returned early leaving the rollups stale forever.
    const chfRate = (d: DatabaseSync) =>
      d
        .prepare(
          'INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('CHF', '2026-05-19', 1.05, 'ecb:frankfurter', FETCHED_AT);

    const truth = new DatabaseSync(':memory:');
    seedCorpus(truth);
    insertUsdRates(truth);
    chfRate(truth);
    derive(truth);

    const db = damagedDb();
    insertUsdRates(db);
    chfRate(db);
    db.exec(repairSql()); // interrupted before any rollup group

    const report = reportFxDamage(runnerFor(db));
    expect(report.total).toBe(0);
    expect(report.interrupted).toBe(true);

    const fetchFn = fxFetchMock();
    const summary = await backfillFx(runnerFor(db), {
      fetchFn,
      fetchedAt: FETCHED_AT,
      refreshSliceSql,
    });
    expect(summary.healed).toBe(true);
    expect(summary.repaired).toBe(0);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    for (const [table, sql] of Object.entries(ROLLUP_QUERIES)) {
      expect(db.prepare(sql).all(), `table ${table}`).toEqual(truth.prepare(sql).all());
    }
    expect(reportFxDamage(runnerFor(db)).interrupted).toBe(false);
  });

  it('leaves BGN/EUR rows and their rollup contributions untouched', async () => {
    const db = damagedDb();
    const before = db
      .prepare(
        "SELECT contract_number, amount_eur FROM contracts WHERE currency IN ('BGN','EUR') ORDER BY 1",
      )
      .all();
    await backfill(db);
    expect(
      db
        .prepare(
          "SELECT contract_number, amount_eur FROM contracts WHERE currency IN ('BGN','EUR') ORDER BY 1",
        )
        .all(),
    ).toEqual(before);
  });
});
