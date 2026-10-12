/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { PROCEDURE_GROUPS } from '@sigma/config';
import {
  contractsSummary,
  listContracts,
  type ContractListParams,
  type ContractSort,
} from './contracts';

// The contracts list reads its headline from contract_rollup and, for a sparse filter, starts its page from
// the narrowest indexed filter. Both are only allowed to change how the numbers and rows are reached, never
// what they are. So one corpus is built twice through the real migrations and precompute.sql: with the
// rollup, and with the rollup emptied — which is the live path the list always had. Every combination of a
// grid of rail filters must give the same headline on both, and the sparse ones the same pages.
//
// The corpus is generated (fixed seed) to hold every edge the rollup's dimensions fold: no date, an empty,
// malformed or future one; no CPV code or a one-character one; eu_funded NULL or 2; no bids count; no amount,
// a negative one, and amounts on every bucket boundary; contracts the list does not show (no tender, no
// authority, no bidder). Six thousand contracts make the sort-index walk long enough to be avoided.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'));
const precompute = readFileSync(resolve(here, '../../../../scripts/precompute.sql'), 'utf8');

const PROCEDURES = [
  'Открита процедура',
  'Публично състезание',
  'Пряко договаряне',
  'Динамична система за покупки',
  'неизвестна',
  'Процедура без група',
];
const CPV = ['45000000', '45100000', '72000000', '33100000', '90500000', null, '9', ''];
const DATES = [
  ...Array.from({ length: 11 }, (_, i) => `${2016 + i}-0${1 + (i % 9)}-1${i % 10}`),
  `${new Date().getUTCFullYear() + 1}-03-01`,
  '2031-01-01',
  null,
  '',
  'abcd',
  '01.02.2019',
  '20-1-05',
];
const AMOUNTS = [
  null,
  -5,
  0,
  50,
  99_999.99,
  100_000,
  999_999.5,
  1_000_000,
  5_000_000,
  9_999_999.99,
  10_000_000,
  50_000_000,
  100_000_000,
  300_000_000,
];

function corpus(sqlite: DatabaseSync): void {
  let seed = 42;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  sqlite.exec(`
    INSERT INTO authorities (id, name, bulstat) VALUES
      ('auth:100000001', 'Институция А', '100000001'), ('auth:100000002', 'Институция Б', '100000002'),
      ('auth:100000003', 'Институция В', '100000003'), ('auth:100000004', 'Институция Г', '100000004');`);
  const bidder = sqlite.prepare(
    `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid) VALUES (?, ?, ?, ?, 1)`,
  );
  for (let i = 0; i < 30; i++) {
    const eik = String(200_000_000 + i);
    bidder.run(`eik:${eik}`, `Фирма ${i}`, eik, eik);
  }
  const tender = sqlite.prepare(
    `INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const authorities = [
    'auth:100000001',
    'auth:100000002',
    'auth:100000003',
    'auth:100000004',
    'auth:missing',
  ];
  for (let i = 0; i < 1500; i++)
    tender.run(
      `t:${i}`,
      `UNP-${i}`,
      `Поръчка ${i}`,
      pick(authorities),
      pick(CPV),
      pick(PROCEDURES),
    );
  const contract = sqlite.prepare(
    `INSERT INTO contracts (id, tender_id, bidder_id, amount, signed_at, eu_funded, bids_received, amount_eur, value_flag, framework)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 6000; i++) {
    const amount = next() < 0.8 ? pick(AMOUNTS) : Math.round(next() * 2e8 * 100) / 100;
    contract.run(
      `c:${String(i).padStart(5, '0')}`,
      next() < 0.01 ? 't:missing' : `t:${Math.floor(next() * 1500)}`,
      next() < 0.01 ? 'eik:missing' : `eik:${200_000_000 + Math.floor(next() * 30)}`,
      pick(DATES),
      pick([0, 1, null, 2]),
      pick([1, 2, 3, null]),
      amount,
      pick(['ok', 'ok', 'ok', 'value_low', 'value_suspect', 'review']),
      // a framework agreement's own record (2) is never in the unverified count, whatever its verdict;
      // from the index, not the generator, so the rest of the corpus stays as it was
      i % 5 === 0 ? 2 : i % 5 === 1 ? 1 : null,
    );
  }
}

/** A database over the corpus, with every statement it is asked recorded. */
function build(withRollup: boolean): { sqlite: DatabaseSync; db: D1Database; sql: string[] } {
  // Without foreign keys, so the corpus can hold contracts the list leaves out — D1 itself would refuse
  // them, which is why the rollup's `in_list` is tested here rather than met in production.
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const migration of migrations) sqlite.exec(migration);
  corpus(sqlite);
  sqlite.exec(precompute);
  if (!withRollup) sqlite.exec('DELETE FROM contract_rollup');
  const inner = d1FromSqlite(sqlite);
  const sql: string[] = [];
  const db = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (query: string) => {
        sql.push(query);
        return target.prepare(query);
      };
    },
  });
  return { sqlite, db, sql };
}

let rollup: ReturnType<typeof build>;
let live: ReturnType<typeof build>;

beforeAll(() => {
  rollup = build(true);
  live = build(false);
});

afterAll(() => {
  rollup.sqlite.close();
  live.sqlite.close();
});

const YEARS = [
  undefined,
  ['2019'],
  ['2019', '2020'],
  ['unknown'],
  ['2024', 'unknown'],
  ['2031'],
  ['abcd'],
];
const SECTORS = [undefined, ['45'], ['45', '72'], ['9']];
const GROUPS = [undefined, ['open'], ['open', 'direct'], ['unknown'], ['not-a-group']];
const BUCKETS = [null, 'lt100k', '100k-1m', 'gt100m', 'not-a-bucket'];
const EU = [null, 'eu', 'national'] as const;
const BIDS = [null, 'one'] as const;

/**
 * Every seventh combination of the grid: 7 shares no factor with the sizes of the inner dimensions (2, 3, 5,
 * 5, 4), so every pairing of their values still occurs, at a seventh of the live counting time.
 */
function* grid(): Generator<ContractListParams> {
  let i = 0;
  for (const years of YEARS)
    for (const sectors of SECTORS)
      for (const procedureGroups of GROUPS)
        for (const valueBucket of BUCKETS)
          for (const eu of EU)
            for (const bids of BIDS)
              if (i++ % 7 === 0) yield { years, sectors, procedureGroups, valueBucket, eu, bids };
}

describe('contract_rollup against the live count', () => {
  it('holds every listed contract, once, in its all-open row', () => {
    const grand = rollup.sqlite
      .prepare(
        `SELECT contracts, value_eur, unverified FROM contract_rollup WHERE procedure_type = '(all)'
           AND eu = '(all)' AND sector = '(all)' AND one_offer = '(all)' AND value_bucket = '(all)' AND year = '(all)'`,
      )
      .get() as { contracts: number; value_eur: number; unverified: number };
    const listed = rollup.sqlite
      .prepare(
        `SELECT COUNT(*) AS contracts, COALESCE(SUM(c.amount_eur), 0) AS value_eur,
                SUM(c.framework IS NOT 2 AND (c.amount_eur IS NULL OR c.value_flag = 'value_low')) AS unverified
         FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
         JOIN bidders b ON b.id = c.bidder_id`,
      )
      .get() as { contracts: number; value_eur: number; unverified: number };
    expect(grand.contracts).toBe(listed.contracts);
    expect(grand.contracts).toBeLessThan(6000); // the corpus does hold contracts the list leaves out
    expect(grand.value_eur).toBeCloseTo(listed.value_eur, 2);
    expect(grand.unverified).toBe(listed.unverified);
  });

  it('gives the list headline the live count for every combination of its rail filters', async () => {
    let fromRollup = 0;
    for (const p of grid()) {
      rollup.sql.length = 0;
      const [a, b] = await Promise.all([
        contractsSummary(rollup.db, p),
        contractsSummary(live.db, p),
      ]);
      expect({ p, total: a.total, suspect: a.suspect }).toEqual({
        p,
        total: b.total,
        suspect: b.suspect,
      });
      expect(Math.abs(a.valueEur - b.valueEur), JSON.stringify(p)).toBeLessThan(0.01);
      if (!rollup.sql.some((s) => s.includes('COUNT(*) AS total'))) fromRollup++;
    }
    // Only a non-four-digit year and an empty sector go live; everything else is a rollup read.
    expect(fromRollup).toBe([...grid()].filter((p) => !p.years?.includes('abcd')).length);
  });

  it('counts live a filter the rollup does not hold', async () => {
    for (const p of [
      { authority: '100000001' },
      { bidder: '200000001' },
      { q: 'поръчка' },
      { years: ['abcd'] },
      { sectors: [''] },
    ] satisfies ContractListParams[]) {
      rollup.sql.length = 0;
      await contractsSummary(rollup.db, p);
      expect(
        rollup.sql.some((s) => s.includes('contract_rollup')),
        JSON.stringify(p),
      ).toBe(false);
    }
  });

  it('counts live while the rollup is empty, or missing altogether', async () => {
    const empty = build(true);
    try {
      empty.sqlite.exec('DROP TABLE contract_rollup');
      const p: ContractListParams = { years: ['2020'], bids: 'one' };
      expect(await contractsSummary(empty.db, p)).toEqual(await contractsSummary(live.db, p));
    } finally {
      empty.sqlite.close();
    }
  });
});

describe('listContracts on a sparse or empty filter', () => {
  const pageSize = 15;

  async function pages(db: D1Database, p: ContractListParams) {
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const page = await listContracts(db, { ...p, pageSize, cursor });
      seen.push({
        items: page.items.map((x) => x.id),
        next: page.nextCursor,
        prev: page.prevCursor,
      });
      if (i === 2 && page.prevCursor) {
        const back = await listContracts(db, { ...p, pageSize, cursor: page.prevCursor });
        seen.push({ back: back.items.map((x) => x.id), next: back.nextCursor });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return seen;
  }

  /**
   * The list's semantics written out plainly, as the oracle: every listed contract, the rail filters as
   * buildFilters states them, the sort with its NULL sentinels and the id tie-break, pages of fifteen.
   */
  function oracle(p: ContractListParams, sort: ContractSort): string[][] {
    const year = new Date().getUTCFullYear();
    const rows = rollup.sqlite
      .prepare(
        `SELECT c.id, c.signed_at, c.amount_eur, c.eu_funded, c.bids_received, t.cpv_code, t.procedure_type
         FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
         JOIN bidders b ON b.id = c.bidder_id`,
      )
      .all() as {
      id: string;
      signed_at: string | null;
      amount_eur: number | null;
      eu_funded: number | null;
      bids_received: number | null;
      cpv_code: string | null;
      procedure_type: string;
    }[];
    const types = (p.procedureGroups ?? []).flatMap(
      (k) => PROCEDURE_GROUPS.find((g) => g.key === k)?.types ?? [],
    );
    const buckets: Record<string, [number, number | null]> = {
      lt100k: [0, 100_000],
      '100k-1m': [100_000, 1_000_000],
      '1m-10m': [1_000_000, 10_000_000],
      '10m-100m': [10_000_000, 100_000_000],
      gt100m: [100_000_000, null],
    };
    const bucket = p.valueBucket ? buckets[p.valueBucket] : undefined;
    const real = (p.years ?? []).filter((y) => y !== 'unknown');
    const unknown = (p.years ?? []).includes('unknown');
    const kept = rows.filter((r) => {
      const head = r.signed_at?.slice(0, 4) ?? null;
      if (p.years?.length) {
        const known = head !== null && /^[0-9]{4}$/.test(head);
        const inReal = head !== null && real.includes(head);
        const inUnknown = unknown && (head === null || !known || Number(head) > year);
        if (!inReal && !inUnknown) return false;
      }
      if (p.sectors?.length && !(r.cpv_code !== null && p.sectors.includes(r.cpv_code.slice(0, 2))))
        return false;
      if (types.length && !types.includes(r.procedure_type)) return false;
      if (bucket) {
        if (r.amount_eur === null || r.amount_eur < bucket[0]) return false;
        if (bucket[1] !== null && r.amount_eur >= bucket[1]) return false;
      }
      if (p.eu === 'eu' && r.eu_funded !== 1) return false;
      if (p.eu === 'national' && !(r.eu_funded === null || r.eu_funded === 0)) return false;
      if (p.bids === 'one' && r.bids_received !== 1) return false;
      return true;
    });
    const key = (r: (typeof rows)[number]): string | number =>
      sort === 'value-desc'
        ? (r.amount_eur ?? -1)
        : sort === 'value-asc'
          ? (r.amount_eur ?? 1e18)
          : sort === 'date-desc'
            ? (r.signed_at ?? '')
            : (r.signed_at ?? '9999-99');
    const desc = sort.endsWith('desc') ? -1 : 1;
    kept.sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (x !== y) return (x < y ? -1 : 1) * desc;
      return (a.id < b.id ? -1 : 1) * desc;
    });
    const ids = kept.map((r) => r.id);
    return [ids.slice(0, 15), ids.slice(15, 30), ids.slice(30, 45)].filter((page) => page.length);
  }

  async function forward(db: D1Database, p: ContractListParams): Promise<string[][]> {
    const out: string[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const page = await listContracts(db, { ...p, pageSize, cursor });
      if (page.items.length) out.push(page.items.map((x) => `c:${x.id}`));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  it('pages every filter as the plain definition does, however each page is reached', async () => {
    const cases: ContractListParams[] = [
      {},
      { years: ['2019'] },
      { years: ['2019'], sectors: ['45'] },
      { years: ['2019', '2020'], valueBucket: 'gt100m' },
      { years: ['2024', 'unknown'], bids: 'one' },
      { years: ['unknown'], sectors: ['72'] },
      { sectors: ['90'], bids: 'one', eu: 'eu' },
      { sectors: ['72'], valueBucket: '100k-1m', procedureGroups: ['open'] },
      { years: ['2021'], sectors: ['33'], valueBucket: 'lt100k' },
      { valueBucket: '10m-100m', years: ['2016'] },
      { valueBucket: 'lt100k', eu: 'national' },
      { years: ['2023'], eu: 'national', bids: 'one', sectors: ['45', '90'] },
      { years: ['2031'], sectors: ['33'], bids: 'one', valueBucket: 'gt100m' },
    ];
    const paths = { driven: 0, bounded: 0, skipped: 0, walked: 0 };
    for (const p of cases)
      for (const sort of ['value-desc', 'value-asc', 'date-desc', 'date-asc'] as const) {
        rollup.sql.length = 0;
        const got = await forward(rollup.db, { ...p, sort });
        expect(got, `${JSON.stringify(p)} ${sort}`).toEqual(oracle(p, sort));
        const page = rollup.sql.find((q) => q.includes('sort_value'));
        if (!page) paths.skipped++;
        else if (page.includes('WITH cand AS MATERIALIZED')) paths.driven++;
        else if (/>= \? AND COALESCE|COALESCE\([^)]*\) >= \?/.test(page)) paths.bounded++;
        else paths.walked++;
      }
    // Every way of reaching a page was taken, and agreed with the definition.
    expect(
      Object.values(paths).every((n) => n > 0),
      JSON.stringify(paths),
    ).toBe(true);
  });

  it('returns the same pages with the rollup as the live list does', async () => {
    for (const p of [
      { years: ['2019'], sectors: ['45'] },
      { sectors: ['90'], bids: 'one', eu: 'eu' },
      { years: ['2023'], eu: 'national', bids: 'one', sectors: ['45', '90'] },
    ] satisfies ContractListParams[])
      for (const sort of ['value-desc', 'date-asc'] as const)
        expect(await forward(rollup.db, { ...p, sort })).toEqual(
          await forward(live.db, { ...p, sort }),
        );
  });

  it('reads no page for a filter that matches nothing', async () => {
    const p: ContractListParams = {
      years: ['2031'],
      sectors: ['33'],
      bids: 'one',
      valueBucket: 'gt100m',
    };
    expect((await contractsSummary(live.db, p)).total).toBe(0);
    rollup.sql.length = 0;
    const page = await listContracts(rollup.db, { ...p, pageSize });
    expect(page).toMatchObject({ items: [], total: 0, nextCursor: null });
    expect(rollup.sql.some((s) => s.includes('sort_value'))).toBe(false);
  });
});
