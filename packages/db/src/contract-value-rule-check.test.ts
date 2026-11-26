// The build gate's contract-value-rule check (scripts/integrity-checks.mjs): every stored contract must
// carry what the value rule (raw_contract_values, scripts/work-staging-schema.sql) gives for its stored
// inputs. A full build passes by construction; each case below writes one stored state an older rule (or a
// broken build) could leave and expects the check to name it, or to hold it when the stored row cannot
// settle it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_CHECKS,
  CHECKS,
  assertIntegrity,
  checkContractValueRule,
  runIntegrityChecks,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migrationDir = 'packages/db/migrations';
const migrations = readdirSync(resolve(root, migrationDir))
  .filter((name) => name.endsWith('.sql'))
  .sort();
const handles: DatabaseSync[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  vi.restoreAllMocks();
});

function freshDb() {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  for (const migration of migrations) db.exec(read(`${migrationDir}/${migration}`));
  return db;
}

function staging(db: DatabaseSync) {
  for (const kind of ['view', 'table']) {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name GLOB 'raw_*'")
      .all(kind)) {
      db.exec(`DROP ${kind} "${String(name)}"`);
    }
  }
  db.exec(read('scripts/work-staging-schema.sql'));
}

interface Signing {
  unp: string;
  signing: number;
  currency?: string;
  own?: number;
  procedure?: number;
  frameworkNotice?: number;
  supplier: string;
}

function signing(db: DatabaseSync, s: Signing) {
  const currency = s.currency ?? 'EUR';
  db.prepare(
    `INSERT INTO raw_tenders (source, fetched_at, unp, authority_eik, authority_name, estimated_value, currency)
      VALUES ('eop:tenders:2026-06-01', '2026-06-01', ?, 'TEST-ORG', 'Община Тест', ?, ?)`,
  ).run(s.unp, s.procedure ?? 100_000, currency);
  db.prepare(
    `INSERT INTO raw_contracts (source, fetched_at, unp, authority_eik, authority_name, contract_number,
      contract_date, signing_value, currency, estimated_value, procurement_currency, contractor_name,
      framework_notice)
    VALUES ('eop:contracts:2026-06-01', '2026-06-01', ?, 'TEST-ORG', 'Община Тест', 'TEST-CONTRACT',
      '2026-06-02', ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.unp,
    s.signing,
    currency,
    s.own ?? 100_000,
    currency,
    s.supplier,
    s.frameworkNotice ?? null,
  );
}

function annex(
  db: DatabaseSync,
  unp: string,
  n: number,
  before: number,
  after: number,
  currency = 'EUR',
) {
  const date = `2026-06-0${2 + n}`;
  db.prepare(
    `INSERT INTO raw_amendments (source, fetched_at, unp, document_number, contract_number,
      published_at, value_before, value_after, value_delta, currency)
    VALUES (?, ?, ?, ?, 'TEST-CONTRACT', ?, ?, ?, ?, ?)`,
  ).run(
    `eop:annexes:${date}`,
    date,
    unp,
    `ANNEX-${n}`,
    date,
    before,
    after,
    after - before,
    currency,
  );
}

// One contract per kind of verdict the rule gives, each under an invented supplier.
function corpus(db: DatabaseSync) {
  staging(db);
  db.exec("INSERT INTO fx_rates VALUES ('USD', '2026-06-01', 0.8, 'test', '2026-06-01')");
  signing(db, { unp: 'U-OK', signing: 10_000, supplier: 'ТЕСТ ГРУП ЕООД' });
  // A framework agreement's own record carries a ceiling, never spending.
  signing(db, { unp: 'U-FRAME', signing: 50_000, frameworkNotice: 1, supplier: 'ТЕСТ РАМКА ООД' });
  // The annex announces a doubled total: the contract sums at its signing value.
  signing(db, { unp: 'U-TOTAL', signing: 10_000, supplier: 'ТЕСТ ДВОЕН ЕООД' });
  annex(db, 'U-TOTAL', 1, 10_000, 20_000);
  // A symbolic signing (1 € against a 50 000 € own estimate) stays value_low, whatever its annex says.
  signing(db, { unp: 'U-SYMBOL', signing: 1, own: 50_000, supplier: 'ТЕСТ СИМВОЛ ЕООД' });
  annex(db, 'U-SYMBOL', 1, 1, 40_000);
  // A low signing against its own estimate, raised by an annex.
  signing(db, { unp: 'U-LOW', signing: 100, own: 100_000, supplier: 'ТЕСТ НИСКО ЕООД' });
  annex(db, 'U-LOW', 1, 100, 50_000);
  // A BGN contract whose annex is published in EUR.
  signing(db, {
    unp: 'U-CCY',
    signing: 19_558.3,
    currency: 'BGN',
    own: 200_000,
    procedure: 200_000,
    supplier: 'ТЕСТ ВАЛУТА ЕООД',
  });
  annex(db, 'U-CCY', 1, 10_000, 12_000, 'EUR');
  // A contract signed in a currency priced at a loaded rate.
  signing(db, { unp: 'U-USD', signing: 10_000, currency: 'USD', supplier: 'ТЕСТ ДОЛАР ЕООД' });
}

function full(db: DatabaseSync) {
  for (const name of [
    'resolve-amendment-contracts',
    'derive-amendments',
    'normalize-raw',
    'promote-amendments',
    'precompute',
  ]) {
    db.exec(read(`scripts/${name}.sql`));
  }
}

function built() {
  const db = freshDb();
  corpus(db);
  full(db);
  return db;
}

const id = (db: DatabaseSync, unp: string) =>
  String(
    (db.prepare('SELECT id FROM contracts WHERE tender_id = ?').get(`t:${unp}`) as { id: string })
      .id,
  );

const store = (db: DatabaseSync, unp: string, set: string) =>
  db.exec(`UPDATE contracts SET ${set} WHERE id = '${id(db, unp)}'`);

const runner = (db: DatabaseSync) => (sql: string) =>
  db.prepare(sql).all() as Array<Record<string, unknown>>;

const CONTRACTS = 7;

const held = (suspect = 0, low = 0) =>
  `held as stored: ${suspect} legacy value_suspect verdict(s) the rule no longer reaches, ` +
  `${low} legacy value_low verdict(s) without a stored own estimate`;

const passing = (suspect = 0, low = 0) =>
  `all ${CONTRACTS} contracts carry what the value rule gives for their stored inputs (${held(suspect, low)})`;

interface Kinds {
  flag?: number;
  amountEur?: number;
  other?: number;
  currency?: number;
  rate?: number;
  annexes?: number;
}

const failing = (n: number, k: Kinds, moved: number, suspect = 0, low = 0) =>
  `${n} of ${CONTRACTS} contract(s) differ from what the value rule gives for their stored inputs — ` +
  `${k.flag ?? 0} flag, ${k.amountEur ?? 0} amount_eur, ${k.other ?? 0} other amount, ` +
  `${k.currency ?? 0} currency, ${k.rate ?? 0} rate, ${k.annexes ?? 0} annex count; ` +
  `${moved.toFixed(2)} € of amount_eur would move (${held(suspect, low)})`;

function stagingRows(db: DatabaseSync) {
  return ['raw_contract_value_inputs', 'raw_contract_value_annexes'].map(
    (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

describe('contract-value-rule (build gate)', () => {
  it('passes on a fresh build, which gives every verdict of the corpus, and leaves staging empty', async () => {
    const db = built();
    const flags = Object.fromEntries(
      (
        db.prepare('SELECT tender_id, value_flag, amount_eur FROM contracts').all() as Array<{
          tender_id: string;
          value_flag: string;
          amount_eur: number | null;
        }>
      ).map((r) => [r.tender_id, [r.value_flag, r.amount_eur && Math.round(r.amount_eur)]]),
    );
    expect(flags).toEqual({
      't:U-OK': ['ok', 10_000],
      't:U-FRAME': ['ok', null],
      't:U-TOTAL': ['annex_total_suspect', 10_000],
      't:U-SYMBOL': ['value_low', 40_000],
      't:U-LOW': ['value_low', 50_000],
      't:U-CCY': ['ok', 12_000],
      't:U-USD': ['ok', 8_000],
    });
    await expect(checkContractValueRule(runner(db))).resolves.toEqual({
      name: 'contract-value-rule',
      ok: true,
      skipped: false,
      detail: passing(),
    });
    expect(stagingRows(db)).toEqual([0, 0]);
  });

  it('names every row an older rule left behind, by kind of difference', async () => {
    const db = built();
    // The ceiling summed as spending.
    store(db, 'U-FRAME', 'amount_eur = 50000');
    // annex_total_suspect summed at the doubled current value.
    store(db, 'U-TOTAL', 'amount = 20000, amount_eur = 20000');
    // The symbolic signing read as an annex jump and summed at 1 €.
    store(
      db,
      'U-SYMBOL',
      "value_flag = 'annex_suspect', amount = 1, amount_eur = 1, current_value_eur = NULL",
    );
    // The EUR annex read as BGN.
    store(
      db,
      'U-CCY',
      "current_value_currency = 'BGN', amount_eur = 12000 / 1.95583, current_value_eur = 12000 / 1.95583",
    );
    const result = await checkContractValueRule(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      failing(
        4,
        { flag: 1, amountEur: 4, other: 3, currency: 1 },
        -50_000 - 10_000 + 39_999 + (12_000 - 12_000 / 1.95583),
      ),
    );
    expect(stagingRows(db)).toEqual([0, 0]);
  });

  // Each comparison on its own: a row that differs in nothing else.
  it.each([
    // A stale review flag on a sound row, every amount as the rule gives it.
    ['flag', 'U-OK', "value_flag = 'review'", { flag: 1 }, 0],
    ['amount_eur', 'U-OK', 'amount_eur = 10001', { amountEur: 1 }, -1],
    ['current value', 'U-TOTAL', 'current_value = 30000', { other: 1 }, 0],
    ['currency', 'U-CCY', "current_value_currency = 'BGN'", { currency: 1 }, 0],
    ['conversion marker', 'U-OK', 'fx_converted = 1', { currency: 1 }, 0],
    ['rate', 'U-USD', 'fx_rate = 0.8 * (1 + 1e-6)', { rate: 1 }, 0],
    ['annex count', 'U-TOTAL', 'annex_count = 2', { annexes: 1 }, 0],
  ] as const)(
    'fails on a row whose only difference is its %s',
    async (_, unp, set, kinds, moved) => {
      const db = built();
      store(db, unp, set);
      await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
        ok: false,
        detail: failing(1, kinds, moved),
      });
    },
  );

  it('takes a signing rate within its relative tolerance as equal', async () => {
    const db = built();
    store(db, 'U-USD', 'fx_rate = 0.8 * (1 + 1e-12)');
    await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
      ok: true,
      detail: passing(),
    });
  });

  it('holds a legacy value_suspect verdict the stored row can no longer reproduce, and counts it', async () => {
    const db = built();
    store(
      db,
      'U-OK',
      "own_estimate_source = NULL, value_flag = 'value_suspect', amount = 100000, amount_eur = 100000, " +
        'signing_value_eur = NULL, current_value_eur = NULL',
    );
    await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
      ok: true,
      detail: passing(1, 0),
    });
    // The hold covers only a legacy row: one whose own estimate is stored is judged like any other.
    store(db, 'U-OK', "own_estimate_source = 'eop:contracts:2026-06-01'");
    await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
      ok: false,
      detail: failing(1, { flag: 1, amountEur: 1, other: 1 }, -90_000),
    });
  });

  it('holds a legacy value_low verdict whose own estimate was never stored, and counts it', async () => {
    const db = built();
    // Without its own estimate the rule would read the 100 € signing raised to 50 000 € as an annex jump.
    store(
      db,
      'U-LOW',
      'own_estimate_source = NULL, own_estimate_value = NULL, own_estimate_currency = NULL',
    );
    await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
      ok: true,
      detail: passing(0, 1),
    });
  });

  it('agrees with the daily annex path, which re-values from the same projection', async () => {
    const db = built();
    store(
      db,
      'U-LOW',
      'own_estimate_source = NULL, own_estimate_value = NULL, own_estimate_currency = NULL',
    );
    staging(db);
    annex(db, 'U-OK', 1, 10_000, 13_000);
    annex(db, 'U-CCY', 2, 12_000, 30_000, 'EUR');
    annex(db, 'U-LOW', 2, 50_000, 60_000);
    db.exec(read('scripts/refresh-slice.sql'));
    expect(
      db
        .prepare(
          `SELECT tender_id, value_flag, round(amount_eur) AS eur, own_estimate_source FROM contracts
          WHERE tender_id IN ('t:U-OK', 't:U-LOW') ORDER BY tender_id`,
        )
        .all(),
    ).toEqual([
      {
        tender_id: 't:U-LOW',
        value_flag: 'value_low',
        eur: 60_000,
        own_estimate_source: 'legacy:value_low',
      },
      {
        tender_id: 't:U-OK',
        value_flag: 'ok',
        eur: 13_000,
        own_estimate_source: 'eop:contracts:2026-06-01',
      },
    ]);
    staging(db);
    await expect(checkContractValueRule(runner(db))).resolves.toMatchObject({
      ok: true,
      detail: passing(0, 1),
    });
  });

  it('fails the build gate on a difference and passes it on a clean build', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = built();
    const quiet = { label: 'test build', exit: false, build: true };
    const results = await assertIntegrity(runner(db), quiet);
    expect(results.find((r) => r.name === 'contract-value-rule')).toMatchObject({ ok: true });
    store(db, 'U-OK', "value_flag = 'review'");
    await expect(assertIntegrity(runner(db), quiet)).rejects.toThrow(
      /1 of 11 checks broke \(test build\): contract-value-rule — 1 of 7 contract\(s\) differ/,
    );
  });

  it('is absent from the served roster', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = built();
    store(db, 'U-OK', "value_flag = 'review'");
    expect(BUILD_CHECKS).toEqual([checkContractValueRule]);
    expect(CHECKS).not.toContain(checkContractValueRule);
    const served = await runIntegrityChecks(runner(db));
    expect(served.map((r) => r.name)).not.toContain('contract-value-rule');
    const results = await assertIntegrity(runner(db), { label: 'served', exit: false });
    expect(results.map((r) => r.name)).not.toContain('contract-value-rule');
  });
});
