import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { refreshSliceStatementGroups } from '../packages/ingest/src/refresh.ts';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const pathToMigrations = 'packages/db/migrations';
const stagingSql = read('scripts/work-staging-schema.sql');
const [resolution, ...derive] = refreshSliceStatementGroups(read('scripts/refresh-slice.sql'));
const base = `
  INSERT INTO raw_tenders (source, fetched_at, unp, authority_eik, authority_name, estimated_value, currency)
  VALUES ('eop:tenders:2026-06-01', '2026-06-01', 'TEST', 'TEST-ORG', 'Test Authority', 100000, 'CAD');
  INSERT INTO raw_contracts (source, fetched_at, unp, authority_eik, authority_name, contract_number,
      contract_date, signing_value, currency, estimated_value, procurement_currency, contractor_name)
  VALUES ('eop:contracts:2026-06-01', '2026-06-01', 'TEST', 'TEST-ORG', 'Test Authority',
      'TEST-CONTRACT', '2026-06-02', 10000, 'EUR', 100000, 'GBP', 'Test Supplier');
`;
const annexes = `
  INSERT INTO raw_amendments (source, fetched_at, unp, document_number, contract_number,
      published_at, value_before, value_after, currency)
  VALUES ('eop:annexes:2026-06-03', '2026-06-03', 'TEST', 'ANCHOR', 'TEST-ALT', '2026-06-03', 10000, 11000, 'EUR'),
    ('eop:annexes:2026-06-04', '2026-06-04', 'TEST', 'USD', 'TEST-ALT', '2026-06-04', 12000, 15000, 'USD');
`;

test('the CLI prices resolved pairs and retains earlier rates in metadata-only slices', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-fx-'));
  const file = join(dir, 'data.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const migration of readdirSync(resolve(root, pathToMigrations)).sort()) {
    if (migration.endsWith('.sql')) db.exec(read(`${pathToMigrations}/${migration}`));
  }
  db.exec(stagingSql);
  const applyGroups = (groups) => db.exec(groups.flatMap((g) => g.statements).join(';\n'));
  const mock = join(dir, 'fetch.mjs');
  const requests = join(dir, 'requests.log');
  const output = join(dir, 'fx.sql');
  writeFileSync(
    mock,
    `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url) => {
      appendFileSync(${JSON.stringify(requests)}, url + '\\n');
      const currency = new URL(url).searchParams.get('base');
      if (currency === 'XTS') return new Response('unsupported', { status: 404 });
      if (process.env.SIGMA_TEST_FX_FAIL === currency) return new Response('unavailable', {status: 503});
      if (currency === 'USD' && process.env.SIGMA_TEST_FX_FAIL === 'malformed')
        return Response.json({message: 'unavailable'});
      if (currency === 'USD' && process.env.SIGMA_TEST_FX_FAIL === 'empty')
        return Response.json({rates: {}});
      const quotes = { CAD: 0.6, GBP: 1.2, USD: 0.8 };
      const payload = {
        amount: 1, base: currency, start_date: '2026-06-01', end_date: '2026-06-01',
        rates: {'2026-06-01': {EUR: quotes[currency]}},
      };
      if (currency === 'USD') {
        switch (process.env.SIGMA_TEST_FX_FAIL) {
          case 'identity': delete payload.base; break;
          case 'reversed': payload.start_date = '2026-06-02'; break;
          case 'future':
            payload.end_date = '2026-06-03';
            payload.rates['2026-06-03'] = {EUR: 0.33};
            break;
        }
      }
      return Response.json(payload);
    };
  `,
  );
  const load = (fail = '') =>
    spawnSync(
      process.execPath,
      ['--import', mock, 'scripts/load-fx.mjs', '--apply', `--work-db=${file}`, `--out=${output}`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, SIGMA_TEST_FX_FAIL: fail } },
    );
  const expectLoad = () => {
    const run = load();
    assert.equal(run.status, 0, run.stderr || run.stdout);
  };
  const calls = () => readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean);
  const request = (currency) =>
    `https://api.frankfurter.dev/v1/2026-05-23..2026-06-02?base=${currency}&symbols=EUR`;
  const value = () => ({
    ...db.prepare('SELECT amount_eur, current_value_eur FROM contracts').get(),
  });

  db.exec(base);
  applyGroups([resolution]);
  expectLoad();
  assert.deepEqual(calls(), [request('CAD'), request('GBP')]);
  applyGroups(derive);

  db.exec('DELETE FROM raw_contracts; DELETE FROM raw_tenders;');
  db.exec(annexes);
  applyGroups([resolution]);
  const failed = load('USD');
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stderr, /USD .*HTTP 503/);
  assert.deepEqual(value(), { amount_eur: 10_000, current_value_eur: null });
  assert.equal(db.prepare('SELECT as_of FROM home_totals').get().as_of, '2026-06-02');

  expectLoad();
  assert.deepEqual(calls(), [request('CAD'), request('GBP'), request('USD'), request('USD')]);
  applyGroups(derive);
  assert.deepEqual(value(), { amount_eur: 12_000, current_value_eur: 12_000 });

  db.exec(`DELETE FROM raw_amendments;
    INSERT INTO raw_amendments (source, fetched_at, unp, document_number, contract_number, published_at)
    VALUES ('eop:annexes:2026-06-05', '2026-06-05', 'TEST', 'NOTE', 'TEST-CONTRACT', '2026-06-05');`);
  applyGroups([resolution]);
  expectLoad();
  assert.equal(calls().length, 4);
  assert.deepEqual(
    db
      .prepare('SELECT base_currency FROM fx_rates ORDER BY base_currency')
      .all()
      .map((r) => r.base_currency),
    ['CAD', 'GBP', 'USD'],
  );
  applyGroups(derive);
  assert.deepEqual(value(), { amount_eur: 12_000, current_value_eur: 12_000 });

  // The same metadata-only slice must request an older annex's quote if the quote is missing.
  db.exec("DELETE FROM fx_rates WHERE base_currency = 'USD'");
  applyGroups([resolution]);
  expectLoad();
  assert.equal(calls().at(-1), request('USD'));
  applyGroups(derive);
  assert.deepEqual(value(), { amount_eur: 12_000, current_value_eur: 12_000 });

  db.exec("DELETE FROM fx_rates WHERE base_currency IN ('CAD', 'USD')");
  applyGroups([resolution]);
  const priorSql = readFileSync(output, 'utf8');
  for (const mode of ['malformed', 'identity', 'reversed', 'future']) {
    const malformed = load(mode);
    assert.equal(malformed.status, 1, malformed.stdout);
    assert.match(malformed.stderr, /malformed FX series for USD/);
    assert.deepEqual(calls().slice(-2), [request('CAD'), request('USD')]);
    assert.equal(readFileSync(output, 'utf8'), priorSql);
    assert.deepEqual(
      db
        .prepare('SELECT base_currency FROM fx_rates')
        .all()
        .map((r) => r.base_currency),
      ['GBP'],
    );
    assert.deepEqual(value(), { amount_eur: 12_000, current_value_eur: 12_000 });
  }

  const empty = load('empty');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /USD .*0 ECB business-day rates/);
  expectLoad();
  applyGroups(derive);
  assert.deepEqual(value(), { amount_eur: 12_000, current_value_eur: 12_000 });

  db.exec(`UPDATE raw_amendments SET value_after = 16000, currency = 'XTS';`);
  applyGroups([resolution]);
  expectLoad();
  assert.equal(calls().at(-1), request('XTS'));
  applyGroups(derive);
  assert.deepEqual(value(), { amount_eur: null, current_value_eur: null });
});
