import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getHomeData } from './queries/home';
import { listAuthorities } from './queries/authorities';
import { listContracts } from './queries/contracts';
import { getAuthority, getCompany, getContract } from './queries/details';
import { authorityIdFromSlug, contractIdFromSlug } from './queries/identity';

// What `pnpm run setup` leaves in a fresh local database: the migrations, scripts/seed.sql, then
// scripts/precompute.sql (the rollups the explorer reads). Run through the real files, so a seed that
// stops matching the identity keys the routes use, or a setup that stops building the rollups, fails here
// instead of showing as an empty explorer in the browser.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migrations = readdirSync(resolve(root, 'packages/db/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

function setup(db: DatabaseSync): void {
  for (const file of migrations) db.exec(read(`packages/db/migrations/${file}`));
  db.exec(read('scripts/seed.sql'));
  db.exec(read('scripts/precompute.sql'));
}

it('is what scripts/setup.mjs runs: migrations, then the seed, then precompute', () => {
  const setupScript = read('scripts/setup.mjs');
  const order = ['migrations', 'seedFile', 'precomputeFile'].map((k) =>
    setupScript.indexOf(k, setupScript.indexOf('try {')),
  );
  expect(order.every((i) => i > -1)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

describe('local setup data (migrations + seed + precompute)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    setup(db);
  });
  afterEach(() => db.close());

  it('fills the home totals from the seeded contracts', async () => {
    const { totals } = await getHomeData(d1FromSqlite(db));
    // c:conflict-01..03 carry 429 000 + 190 000 + 120 000 EUR across three authorities and winners.
    expect(totals).toMatchObject({ contracts: 3, valueEur: 739000, authorities: 3, bidders: 3 });
  });

  it('lists the seeded authorities and contracts, with the keys the routes resolve', async () => {
    const d1 = d1FromSqlite(db);
    const authorities = await listAuthorities(d1, {});
    expect(authorities.items.map((a) => a.name).sort()).toEqual([
      'Министерство на регионалното развитие',
      'Община Пример',
      'Община София',
    ]);
    const contracts = await listContracts(d1, {});
    expect(contracts.items.map((c) => c.id).sort()).toEqual([
      'conflict-01',
      'conflict-02',
      'conflict-03',
    ]);
    // Every link the lists render must open: the defect was lists that linked to pages answering 404.
    for (const c of contracts.items) {
      expect(await getContract(d1, contractIdFromSlug(c.id))).not.toBeNull();
    }
    for (const a of authorities.items) {
      expect(await getAuthority(d1, authorityIdFromSlug(a.slug))).not.toBeNull();
    }
  });

  it('opens a seeded authority, contract and company through the route identity keys', async () => {
    const d1 = d1FromSqlite(db);
    const authority = await getAuthority(d1, authorityIdFromSlug('000696327'));
    expect(authority?.name).toBe('Община София');
    expect(authority?.contracts).toBe(1);

    const contract = await getContract(d1, contractIdFromSlug('conflict-01'));
    expect(contract?.contractNumber).toBe('Д-2022-101');
    expect(contract?.authority.name).toBe('Община Пример');
    expect(contract?.bidder.name).toBe('АЛФА СТРОЙ ООД');

    const company = await getCompany(d1, 'eik:201122335');
    expect(company?.name).toBe('АЛФА СТРОЙ ООД');
    expect(company?.contracts).toBe(1);
  });

  it('can be applied again without duplicating rows or changing the totals', async () => {
    const before = await getHomeData(d1FromSqlite(db));
    db.exec(read('scripts/seed.sql'));
    db.exec(read('scripts/precompute.sql'));
    const after = await getHomeData(d1FromSqlite(db));
    expect(after.totals).toMatchObject({ contracts: 3, valueEur: 739000 });
    expect(after.totals.valueEur).toBe(before.totals.valueEur);
    expect(db.prepare('SELECT COUNT(*) AS n FROM authorities').get()).toEqual({ n: 3 });
  });
});
