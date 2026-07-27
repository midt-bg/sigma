/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWeeklyAuthorityBreakdown,
  getWeeklyCounts,
  getWeeklyDailySpend,
  getWeeklyDigestData,
  getWeeklyLargestContract,
  getWeeklySectorBreakdown,
  getWeeklySingleBidRate,
  getWeeklyTopContracts,
  getWeeklyTotal,
  getWeeklyTotalDelta,
  priorIsoWeek,
  reconcileWeeklyTotal,
} from './weekly';

// Integration tier (mirrors contracts-filter-sql.test.ts, issue #138's node:sqlite harness): runs the
// real query SQL against a real SQLite engine built from the WHOLE migration chain, so the ISO-week
// bucketing (strftime('%G-W%V', …)) and the boundary/NULL/floor edge cases are proven against the
// actual engine, not a fake D1 that would rubber-stamp any WHERE clause.
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const TARGET_WEEK = '2024-W01'; // Mon 2024-01-01 .. Sun 2024-01-07 (real ISO week, verified via sqlite3 CLI)
const PRIOR_WEEK = '2023-W52'; // the real prior ISO week of 2024-W01 (year-boundary case)
const EMPTY_WEEK = '2030-W01';

const BASE_FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Институция А', '100000001', 'община'),
  ('auth:100000002', 'Институция Б', '100000002', 'агенция');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'Фирма Х', '200000001', '200000001', 1, 'company'),
  ('eik:200000002', 'Фирма Y', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:A', 'UNP-A', 'Поръчка А', 'auth:100000001', '45000000', 'открита процедура', 'awarded'),
  ('t:B', 'UNP-B', 'Поръчка Б', 'auth:100000002', '30000000', 'открита процедура', 'awarded');

-- Target week (2024-W01): Monday, the last instant of Sunday, and one NULL-amount (excluded) row.
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:MON',       't:A', 'eik:200000001', 1000, 'EUR', '2024-01-01',          1, 'ok',            1000),
  ('c:SUN',       't:B', 'eik:200000002', 2000, 'EUR', '2024-01-07 23:59:00', 2, 'ok',            2000),
  ('c:NULLAMT',   't:A', 'eik:200000001', 300,  'EUR', '2024-01-03',          0, 'value_suspect',  NULL);

-- The very next instant (Monday 00:00 of the FOLLOWING week) must never leak into 2024-W01.
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:NEXTWEEK', 't:A', 'eik:200000001', 5000, 'EUR', '2024-01-08 00:00:00', 1, 'ok', 5000);

-- Prior week (2023-W52 — the real ISO prior week of 2024-W01, not merely "7 days back" in the naive
-- Gregorian sense) for the week-over-week delta.
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:PRIOR', 't:A', 'eik:200000001', 500, 'EUR', '2023-12-28', 1, 'ok', 500);

INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, refreshed_at) VALUES
  (1, 5, 3000, 2, 2, 1, '2024-01-08T00:00:00Z');
`;

/** Minimal D1Database facade over node:sqlite — enough for the query layer's prepare/bind/all/first. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: (string | number | null)[] = [];
      const stmt = {
        bind(...params: (string | number | null)[]) {
          bound = params;
          return stmt;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...bound) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...bound) ?? null) as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

let open: DatabaseSync | null = null;

/** 25 extra contracts in a DIFFERENT week (2024-W10), isolated from every other assertion, purely to
 *  put the single-bid-rate sample at/over the reporting floor (15 single-bid, 10 not). */
function floorWeekFixture(): string {
  const rows: string[] = [];
  for (let i = 0; i < 25; i++) {
    const bids = i < 15 ? 1 : 2;
    rows.push(
      `('c:FLOOR-${i}', 't:A', 'eik:200000001', 100, 'EUR', '2024-03-0${(i % 5) + 4}', ${bids}, 'ok', 100)`,
    );
  }
  return `INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES\n${rows.join(',\n')};`;
}

const FLOOR_WEEK = '2024-W10';

function realDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const m of migrations) db.exec(readFileSync(resolve(migrationsDir, m), 'utf8'));
  db.exec(BASE_FIXTURE);
  db.exec(floorWeekFixture());
  open = db;
  return d1(db);
}

afterEach(() => {
  open?.close();
  open = null;
});

describe('priorIsoWeek (#167)', () => {
  it('steps back one ISO week within a year', () => {
    expect(priorIsoWeek('2024-W02')).toBe('2024-W01');
  });

  it('crosses a year boundary onto the correct ISO week-year (real sqlite: 2024-W01 -> 2023-W52)', () => {
    expect(priorIsoWeek(TARGET_WEEK)).toBe(PRIOR_WEEK);
  });

  it('crosses a year boundary the other direction (2026-W01 -> 2025-W52)', () => {
    expect(priorIsoWeek('2026-W01')).toBe('2025-W52');
  });
});

describe('getWeeklyDailySpend (spec §3.4)', () => {
  it('projects clean spend onto 7 Mon..Sun slots for the week and the prior week', async () => {
    const daily = await getWeeklyDailySpend(realDb(), TARGET_WEEK);
    expect(daily.current).toHaveLength(7);
    expect(daily.previous).toHaveLength(7);
    expect(daily.current.map((d) => d.label)).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']);
    // Monday 2024-01-01 = 1000, Sunday 2024-01-07 = 2000; c:NULLAMT excluded, other days zero-filled.
    expect(daily.current[0]).toMatchObject({ dateIso: '2024-01-01', valueEur: 1000 });
    expect(daily.current[6]).toMatchObject({ dateIso: '2024-01-07', valueEur: 2000 });
    expect(daily.current[1]!.valueEur).toBe(0);
    // Prior week 2023-W52 (Mon 2023-12-25 .. Sun 2023-12-31); c:PRIOR on Thu 2023-12-28 = 500.
    expect(daily.previous[0]!.dateIso).toBe('2023-12-25');
    expect(daily.previous[3]).toMatchObject({ dateIso: '2023-12-28', valueEur: 500 });
  });

  it('never leaks the following week (c:NEXTWEEK 2024-01-08) into a current-week slot', async () => {
    const daily = await getWeeklyDailySpend(realDb(), TARGET_WEEK);
    expect(daily.current.every((d) => d.valueEur !== 5000)).toBe(true);
  });
});

describe('getWeeklyTotal (indicator a, #167)', () => {
  it('sums only clean (amount_eur IS NOT NULL) rows signed within the ISO week', async () => {
    const db = realDb();
    const { totalEur } = await getWeeklyTotal(db, TARGET_WEEK);
    // c:MON (1000) + c:SUN (2000); c:NULLAMT excluded (NULL amount_eur), c:NEXTWEEK excluded (next week).
    expect(totalEur).toBe(3000);
  });

  it('includes the last instant of Sunday and excludes the first instant of the next Monday', async () => {
    const db = realDb();
    const { totalEur: withoutNextWeek } = await getWeeklyTotal(db, TARGET_WEEK);
    const { totalEur: nextWeekTotal } = await getWeeklyTotal(db, '2024-W02');
    expect(withoutNextWeek).toBe(3000); // includes c:SUN's 23:59:00
    expect(nextWeekTotal).toBe(5000); // c:NEXTWEEK's 00:00:00 lands in W02, not W01
  });

  it('returns 0 for a week with no rows', async () => {
    const db = realDb();
    expect((await getWeeklyTotal(db, EMPTY_WEEK)).totalEur).toBe(0);
  });
});

describe('getWeeklyCounts (indicator b, #167)', () => {
  it('counts every signed contract in the week, including the NULL-amount row', async () => {
    const db = realDb();
    const counts = await getWeeklyCounts(db, TARGET_WEEK);
    expect(counts.contracts).toBe(3); // c:MON, c:SUN, c:NULLAMT
    expect(counts.tenders).toBe(2); // distinct tender_id: t:A (MON, NULLAMT), t:B (SUN)
  });

  // The digest's totals strip renders `contractsWithAmount` NEXT TO the week's SUM(amount_eur), so the
  // two must cover ONE row set (precompute.sql's COUNT/SUM CONSISTENCY rule). `contracts` stays the
  // raw activity volume (COUNT(*)) that the zero-row gate keys on — deliberately a different number.
  it('counts the clean-amount rows separately, so a count paired with a money sum covers one row set', async () => {
    const db = realDb();
    const counts = await getWeeklyCounts(db, TARGET_WEEK);
    expect(counts.contractsWithAmount).toBe(2); // c:MON, c:SUN — c:NULLAMT is excluded
    expect(counts.contracts).toBe(3); // volume still counts it
  });

  it('is empty for a week with no rows', async () => {
    const db = realDb();
    const counts = await getWeeklyCounts(db, EMPTY_WEEK);
    expect(counts).toEqual({ contracts: 0, contractsWithAmount: 0, tenders: 0 });
  });
});

describe('getWeeklyLargestContract (indicator c, #167)', () => {
  it('picks the highest amount_eur row and carries link ids', async () => {
    const db = realDb();
    const largest = await getWeeklyLargestContract(db, TARGET_WEEK);
    expect(largest).not.toBeNull();
    expect(largest!.contractSlug).toBe('SUN');
    expect(largest!.amountEur).toBe(2000);
    expect(largest!.authoritySlug).toBe('100000002');
    expect(largest!.bidderSlug).toBe('200000002');
    expect(largest!.tenderUnp).toBe('UNP-B');
  });

  it('is null for a week with no rows', async () => {
    const db = realDb();
    expect(await getWeeklyLargestContract(db, EMPTY_WEEK)).toBeNull();
  });
});

describe('getWeeklySingleBidRate (indicator d, #167)', () => {
  it('returns null below the 20-sample reporting floor, even though the raw ratio is computable', async () => {
    const db = realDb();
    const rate = await getWeeklySingleBidRate(db, TARGET_WEEK);
    // sample = c:MON (bids=1) + c:SUN (bids=2); c:NULLAMT excluded (bids_received=0, not >=1). Only 2
    // qualifying rows — a 50% figure here would be meaningless, so the floor must suppress it.
    expect(rate.sample).toBe(2);
    expect(rate.singleBid).toBe(1);
    expect(rate.rate).toBeNull();
  });

  it('reports a real rate once the sample reaches the floor', async () => {
    const db = realDb();
    const rate = await getWeeklySingleBidRate(db, FLOOR_WEEK);
    expect(rate.sample).toBe(25);
    expect(rate.singleBid).toBe(15);
    expect(rate.rate).toBeCloseTo(15 / 25);
  });
});

describe('getWeeklyTotalDelta (indicator e, #167)', () => {
  it('diffs this week against the real prior ISO week (year-boundary case)', async () => {
    const db = realDb();
    const delta = await getWeeklyTotalDelta(db, TARGET_WEEK);
    expect(delta.priorIsoWeek).toBe(PRIOR_WEEK);
    expect(delta.currentEur).toBe(3000);
    expect(delta.priorEur).toBe(500); // c:PRIOR
    expect(delta.deltaEur).toBe(2500);
    expect(delta.deltaPct).toBeCloseTo(5); // +500%
  });

  it('reports a null pct (not Infinity/NaN) when the prior week had zero clean spend', async () => {
    const db = realDb();
    const delta = await getWeeklyTotalDelta(db, EMPTY_WEEK);
    expect(delta.currentEur).toBe(0);
    expect(delta.priorEur).toBe(0);
    expect(delta.deltaEur).toBe(0);
    expect(delta.deltaPct).toBeNull();
  });
});

describe('getWeeklyTopContracts (indicator f, #167)', () => {
  it('orders by amount_eur desc, separates entity ids from display text, guards value_flag', async () => {
    const db = realDb();
    const top = await getWeeklyTopContracts(db, TARGET_WEEK);
    expect(top).toHaveLength(2); // c:NULLAMT excluded (no clean amount), c:NEXTWEEK excluded (next week)
    expect(top[0]!.contractSlug).toBe('SUN');
    expect(top[0]!.amountEur).toBe(2000);
    expect(top[0]!.authorityId).toBe('auth:100000002');
    expect(top[0]!.authoritySlug).toBe('100000002');
    expect(top[0]!.authorityName).toBe('Институция Б');
    expect(top[0]!.bidderId).toBe('eik:200000002');
    expect(top[1]!.contractSlug).toBe('MON');
    expect(top[1]!.amountEur).toBe(1000);
  });

  it('is empty for a week with no rows', async () => {
    const db = realDb();
    expect(await getWeeklyTopContracts(db, EMPTY_WEEK)).toEqual([]);
  });
});

describe('getWeeklySectorBreakdown (indicator g, #167)', () => {
  it('groups clean-basis spend by 2-digit CPV division, desc by value', async () => {
    const db = realDb();
    const sectors = await getWeeklySectorBreakdown(db, TARGET_WEEK);
    expect(sectors).toEqual([
      { division: '30', contracts: 1, valueEur: 2000 },
      { division: '45', contracts: 1, valueEur: 1000 },
    ]);
  });

  it('is empty for a week with no rows', async () => {
    const db = realDb();
    expect(await getWeeklySectorBreakdown(db, EMPTY_WEEK)).toEqual([]);
  });
});

describe('getWeeklyAuthorityBreakdown (indicator h, #167)', () => {
  it('groups clean-basis spend by authority, desc by value, limited to 10', async () => {
    const db = realDb();
    const authorities = await getWeeklyAuthorityBreakdown(db, TARGET_WEEK);
    expect(authorities).toEqual([
      {
        authorityId: 'auth:100000002',
        authoritySlug: '100000002',
        authorityName: 'Институция Б',
        contracts: 1,
        valueEur: 2000,
      },
      {
        authorityId: 'auth:100000001',
        authoritySlug: '100000001',
        authorityName: 'Институция А',
        contracts: 1,
        valueEur: 1000,
      },
    ]);
  });

  it('is empty for a week with no rows', async () => {
    const db = realDb();
    expect(await getWeeklyAuthorityBreakdown(db, EMPTY_WEEK)).toEqual([]);
  });
});

describe('getWeeklyDigestData (aggregate, #167)', () => {
  it('assembles all eight indicators for one ISO week', async () => {
    const db = realDb();
    const digest = await getWeeklyDigestData(db, TARGET_WEEK);
    expect(digest.isoWeek).toBe(TARGET_WEEK);
    expect(digest.total.totalEur).toBe(3000);
    expect(digest.counts.contracts).toBe(3);
    expect(digest.largest!.contractSlug).toBe('SUN');
    expect(digest.singleBidRate.rate).toBeNull();
    expect(digest.delta.priorIsoWeek).toBe(PRIOR_WEEK);
    expect(digest.topContracts).toHaveLength(2);
    expect(digest.sectors).toHaveLength(2);
    expect(digest.authorities).toHaveLength(2);
  });
});

describe('reconcileWeeklyTotal (#167)', () => {
  it('is within bounds and silent when the week sum does not exceed home_totals.value_eur', async () => {
    const db = realDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileWeeklyTotal(db, TARGET_WEEK);
    expect(result.weekEur).toBe(3000);
    expect(result.homeTotalEur).toBe(3000);
    expect(result.withinBounds).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs (but does not throw) when the week sum exceeds the all-time rollup', async () => {
    const db = realDb();
    await db.prepare(`UPDATE home_totals SET value_eur = ? WHERE id = 1`).bind(100).all();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileWeeklyTotal(db, TARGET_WEEK);
    expect(result.withinBounds).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
