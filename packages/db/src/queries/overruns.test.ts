import { describe, expect, it } from 'vitest';
import {
  getOverrunAnnexes,
  getOverrunsAnalytics,
  getOverrunsHeadline,
  getTopOverruns,
} from './overruns';

// getTopOverruns runs two statements (see overruns.ts): a leaderboard SELECT (carries ORDER BY +
// LIMIT, read via .all) and a corpus-totals SELECT (COUNT(*)/SUM, read via .first). There's no real
// D1 here, so the fakes key off SQL markers — the leaderboard is the one with ORDER BY. Naming the
// markers keeps the assertions reading as intent and localises any future SQL change.
const isLeaderboard = (sql: string) => sql.includes('ORDER BY');
const ordersByAbsolute = (sql: string) =>
  sql.includes('(c.current_value_eur - c.signing_value_eur) DESC');
const ordersByPercent = (sql: string) =>
  sql.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC');

const rawRow = (over: Partial<Record<string, unknown>> = {}) => ({
  contract_id: 'c:123',
  subject: 'Доставка на услуги',
  authority_id: 'auth:000695089',
  authority_name: 'Министерство на финансите',
  bidder_id: 'eik:103267194',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  bidder_eik: '103267194',
  signing_eur: 1_000_000,
  current_eur: 1_500_000,
  annex_count: 2,
  cpv_code: '45233110',
  cpv_description: 'Строеж на магистрали',
  procedure_type: 'Открита процедура',
  eu_funded: 1,
  eu_programme: 'ОПТТИ',
  signed_at: '2022-03-12',
  end_date: '2024-12-31',
  duration_days: 540,
  ...over,
});

// Fake D1 keyed by SQL marker: leaderboard SELECT → `rows` via .all; totals SELECT → `totals` via
// .first. Also records every prepared statement so the ordering tests can pin which ORDER BY ran.
function fakeDb(
  rows: ReturnType<typeof rawRow>[] = [rawRow()],
  totals: { total_overrun_eur: number; count: number } = { total_overrun_eur: 500_000, count: 1 },
): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
        async first<T>() {
          return totals as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe('getTopOverruns', () => {
  it('orders by absolute delta for by="absolute"', async () => {
    const { db, sql } = fakeDb();

    await getTopOverruns(db, { by: 'absolute' });

    const board = sql.find(isLeaderboard)!;
    expect(ordersByAbsolute(board)).toBe(true);
    expect(ordersByPercent(board)).toBe(false);
  });

  it('orders by percentage blow-up for by="percent"', async () => {
    const { db, sql } = fakeDb();

    await getTopOverruns(db, { by: 'percent' });

    const board = sql.find(isLeaderboard)!;
    expect(ordersByPercent(board)).toBe(true);
  });

  it('maps a row to slugs, delta and pct', async () => {
    const { db } = fakeDb();

    const { rows } = await getTopOverruns(db, { by: 'absolute' });

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.contractSlug).toBe('123');
    expect(r.authoritySlug).toBe('000695089');
    expect(r.bidderSlug).toBe('103267194');
    expect(r.signingEur).toBe(1_000_000);
    expect(r.currentEur).toBe(1_500_000);
    expect(r.deltaEur).toBe(500_000);
    expect(r.pct).toBeCloseTo(0.5);
    expect(r.annexCount).toBe(2);
  });

  it('maps real contract metadata for the inspector „ДЕТАЙЛИ ПО ДОГОВОРА" grid', async () => {
    const { db } = fakeDb();

    const { rows } = await getTopOverruns(db, { by: 'absolute' });
    const r = rows[0]!;

    expect(r.cpvCode).toBe('45233110');
    expect(r.cpvDescription).toBe('Строеж на магистрали');
    expect(r.sectorLabel).not.toBe('45'); // resolved to the curated CPV-division label
    expect(r.procedureType).toBe('Открита процедура');
    expect(r.euFunded).toBe(true);
    expect(r.euProgramme).toBe('ОПТТИ');
    expect(r.signedAt).toBe('2022-03-12');
    expect(r.authorityEik).toBe('000695089');
    expect(r.bidderEik).toBe('103267194');
    // term fields for the „Срок" row + status badge
    expect(r.endDate).toBe('2024-12-31');
    expect(r.durationDays).toBe(540);
  });

  it('keeps inspector metadata honest when columns are NULL', async () => {
    const { db } = fakeDb([
      rawRow({
        cpv_code: null,
        cpv_description: null,
        procedure_type: null,
        eu_funded: null,
        eu_programme: null,
        signed_at: null,
        bidder_eik: null,
        end_date: null,
        duration_days: null,
      }),
    ]);

    const { rows } = await getTopOverruns(db, { by: 'absolute' });
    const r = rows[0]!;

    expect(r.cpvCode).toBeNull();
    expect(r.sectorLabel).toBe('Без код');
    expect(r.euFunded).toBeNull();
    expect(r.bidderEik).toBeNull();
    expect(r.signedAt).toBeNull();
    expect(r.endDate).toBeNull();
    expect(r.durationDays).toBeNull();
  });

  it('applies the €1 000 signing floor — skips zero/negative/tiny signing (runaway-pct guard)', async () => {
    const { db } = fakeDb([
      rawRow({ contract_id: 'c:ok' }),
      rawRow({ contract_id: 'c:zero', signing_eur: 0, current_eur: 10_000 }),
      rawRow({ contract_id: 'c:neg', signing_eur: -5, current_eur: 10_000 }),
      rawRow({ contract_id: 'c:tiny', signing_eur: 500, current_eur: 10_000 }),
    ]);

    const { rows } = await getTopOverruns(db, { by: 'percent' });

    expect(rows.map((r) => r.contractSlug)).toEqual(['ok']);
    expect(rows.every((r) => Number.isFinite(r.pct))).toBe(true);
  });

  it('passes through corpus totals (sum of deltas + count)', async () => {
    const { db } = fakeDb([rawRow()], { total_overrun_eur: 12_345_678, count: 42 });

    const result = await getTopOverruns(db, { by: 'absolute' });

    expect(result.totalOverrunEur).toBe(12_345_678);
    expect(result.count).toBe(42);
  });

  it('returns an honest empty result with zero totals', async () => {
    const { db } = fakeDb([], { total_overrun_eur: 0, count: 0 });

    const result = await getTopOverruns(db, { by: 'absolute' });

    expect(result.rows).toHaveLength(0);
    expect(result.totalOverrunEur).toBe(0);
    expect(result.count).toBe(0);
  });
});

// ── getOverrunsAnalytics ───────────────────────────────────────────────────────────
// Five bounded statements; the fake keys each off a unique SQL marker (see overruns.ts) and serves the
// right shaped result via .all (lists) or .first (single-row aggregates). Marker presence is also the
// "no duplicate COUNT / each aggregate is one bounded query" guard.
const MARKERS = {
  leaderboard: 'JOIN bidders b', // the only statement that joins bidders → the per-contract board
  corpus: 'corpus_signing_eur', // single conditional-aggregate pass
  median: 'median_pct', // window-function median
  authority: 'GROUP BY t.authority_id',
  sector: 'GROUP BY division',
} as const;

type AnalyticsFakes = {
  leaderboard?: ReturnType<typeof rawRow>[];
  corpus?: Record<string, number>;
  median?: { median_pct: number };
  authority?: Record<string, unknown>[];
  sector?: Record<string, unknown>[];
};

function fakeAnalyticsDb(f: AnalyticsFakes = {}): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const corpus = f.corpus ?? {
    total_overrun_eur: 9_000_000,
    count: 3,
    avg_pct: 0.5,
    corpus_signing_eur: 90_000_000,
  };
  const median = f.median ?? { median_pct: 0.42 };
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (q.includes(MARKERS.leaderboard))
            return { results: (f.leaderboard ?? [rawRow()]) as T[] };
          if (q.includes(MARKERS.authority)) return { results: (f.authority ?? []) as T[] };
          if (q.includes(MARKERS.sector)) return { results: (f.sector ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (q.includes(MARKERS.median)) return median as T;
          if (q.includes(MARKERS.corpus)) return corpus as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe('getOverrunsAnalytics', () => {
  it('issues exactly five bounded queries, one per section', async () => {
    const { db, sql } = fakeAnalyticsDb();

    await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(sql).toHaveLength(5);
    for (const marker of Object.values(MARKERS)) {
      expect(sql.some((q) => q.includes(marker))).toBe(true);
    }
    // The corpus totals come from one conditional-aggregate pass — the count is a SUM(CASE…), not a
    // duplicate COUNT(*) over the contracts table (the perf-review trap).
    const corpusSql = sql.find((q) => q.includes(MARKERS.corpus))!;
    expect(corpusSql.includes('COUNT(*)')).toBe(false);
    expect(corpusSql.includes('SUM(CASE WHEN')).toBe(true);
  });

  it('honours the leaderboard sort toggle', async () => {
    const abs = fakeAnalyticsDb();
    await getOverrunsAnalytics(abs.db, { by: 'absolute' });
    const absBoard = abs.sql.find((q) => q.includes(MARKERS.leaderboard))!;
    expect(
      absBoard.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC'),
    ).toBe(false);

    const pctRun = fakeAnalyticsDb();
    await getOverrunsAnalytics(pctRun.db, { by: 'percent' });
    const pctBoard = pctRun.sql.find((q) => q.includes(MARKERS.leaderboard))!;
    expect(
      pctBoard.includes('(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur DESC'),
    ).toBe(true);
  });

  it('derives share-of-signing from the corpus aggregate', async () => {
    const { db } = fakeAnalyticsDb({
      corpus: {
        total_overrun_eur: 9_000_000,
        count: 3,
        avg_pct: 0.5,
        corpus_signing_eur: 90_000_000,
      },
      median: { median_pct: 0.42 },
    });

    const { corpus } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(corpus.totalOverrunEur).toBe(9_000_000);
    expect(corpus.count).toBe(3);
    expect(corpus.avgPct).toBeCloseTo(0.5);
    expect(corpus.medianPct).toBeCloseTo(0.42);
    expect(corpus.shareOfSigning).toBeCloseTo(0.1); // 9M / 90M
  });

  it('guards share-of-signing against a zero denominator', async () => {
    const { db } = fakeAnalyticsDb({
      corpus: {
        total_overrun_eur: 0,
        count: 0,
        avg_pct: 0,
        corpus_signing_eur: 0,
      },
      median: { median_pct: 0 },
    });

    const { corpus } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(corpus.shareOfSigning).toBe(0);
    expect(Number.isFinite(corpus.shareOfSigning)).toBe(true);
  });

  it('maps authority rows to slugs, clean names and €-weighted growth', async () => {
    const { db } = fakeAnalyticsDb({
      authority: [
        {
          authority_id: 'auth:000695089',
          authority_name: 'Министерство на финансите',
          total_overrun_eur: 5_000_000,
          signing_eur: 20_000_000,
          count: 7,
        },
      ],
    });

    const { byAuthority } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(byAuthority).toHaveLength(1);
    expect(byAuthority[0]!.authoritySlug).toBe('000695089');
    expect(byAuthority[0]!.totalOverrunEur).toBe(5_000_000);
    expect(byAuthority[0]!.count).toBe(7);
    // growth = SUM(delta) / SUM(signing) = 5M / 20M, not an average of per-contract pcts.
    expect(byAuthority[0]!.growth).toBeCloseTo(0.25);
  });

  it('guards authority growth against a zero signing denominator', async () => {
    const { db } = fakeAnalyticsDb({
      authority: [
        {
          authority_id: 'auth:1',
          authority_name: 'X',
          total_overrun_eur: 1_000,
          signing_eur: 0,
          count: 1,
        },
      ],
    });
    const { byAuthority } = await getOverrunsAnalytics(db, { by: 'absolute' });
    expect(byAuthority[0]!.growth).toBe(0);
    expect(Number.isFinite(byAuthority[0]!.growth)).toBe(true);
  });

  it('labels CPV divisions, assigns the works/goods/services bucket and €-weighted growth', async () => {
    const { db } = fakeAnalyticsDb({
      sector: [
        { division: '45', risk_eur: 8_000_000, signing_eur: 16_000_000, count: 12 }, // works
        { division: '72', risk_eur: 4_000_000, signing_eur: 10_000_000, count: 6 }, // services
        { division: '33', risk_eur: 3_000_000, signing_eur: 6_000_000, count: 5 }, // goods
        { division: '99', risk_eur: 2_000_000, signing_eur: 4_000_000, count: 3 }, // not in taxonomy
        { division: null, risk_eur: 1_000_000, signing_eur: 2_000_000, count: 1 }, // NULL cpv_code
      ],
    });

    const { bySector } = await getOverrunsAnalytics(db, { by: 'absolute' });

    expect(bySector[0]!.code).toBe('45');
    expect(bySector[0]!.label).not.toBe('45'); // resolved to the curated/official CPV label
    expect(bySector[0]!.bucket).toBe('works');
    expect(bySector[0]!.riskEur).toBe(8_000_000);
    expect(bySector[0]!.contracts).toBe(12);
    expect(bySector[0]!.growth).toBeCloseTo(0.5); // 8M / 16M
    expect(bySector[1]!.bucket).toBe('services');
    expect(bySector[2]!.bucket).toBe('goods');
    expect(bySector[3]!.label).toBe('Сектор 99'); // present in corpus but not in the taxonomy
    expect(bySector[3]!.bucket).toBe('other');
    expect(bySector[4]!.label).toBe('Без код'); // NULL cpv_code
    expect(bySector[4]!.bucket).toBe('other');
  });

  it('returns honest empty breakdowns when there are no overruns', async () => {
    const { db } = fakeAnalyticsDb({
      leaderboard: [],
      corpus: {
        total_overrun_eur: 0,
        count: 0,
        avg_pct: 0,
        corpus_signing_eur: 0,
      },
      median: { median_pct: 0 },
      authority: [],
      sector: [],
    });

    const { rows, byAuthority, bySector, corpus } = await getOverrunsAnalytics(db, {
      by: 'absolute',
    });

    expect(rows).toHaveLength(0);
    expect(byAuthority).toHaveLength(0);
    expect(bySector).toHaveLength(0);
    expect(corpus.count).toBe(0);
  });
});

// ── getOverrunAnnexes ────────────────────────────────────────────────────────────────
// One bounded IN-list query joining contracts → tenders → amendments. The fake records the SQL and the
// bound params so we can assert the bounded shape (no per-row query) and the EUR normalisation.
const annexRaw = (over: Partial<Record<string, unknown>> = {}) => ({
  contract_id: 'c:123',
  value_before: 1_000_000,
  value_after: 1_300_000,
  value_delta: 300_000,
  currency: 'BGN',
  published_at: '2023-05-01',
  description: 'Допълнителни количества СМР',
  ...over,
});

function fakeAnnexDb(rows: ReturnType<typeof annexRaw>[] = [annexRaw()]): {
  db: D1Database;
  sql: string[];
  bound: unknown[][];
} {
  const sql: string[] = [];
  const bound: unknown[][] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind(...args: unknown[]) {
          bound.push(args);
          return this;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
        async first<T>() {
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, sql, bound };
}

describe('getOverrunAnnexes', () => {
  it('runs no query for an empty id list', async () => {
    const { db, sql } = fakeAnnexDb();

    const out = await getOverrunAnnexes(db, []);

    expect(out).toEqual([]);
    expect(sql).toHaveLength(0); // never touches D1 when nothing is shown
  });

  it('issues exactly one bounded IN-list query and binds every id', async () => {
    const { db, sql, bound } = fakeAnnexDb([]);

    await getOverrunAnnexes(db, ['c:1', 'c:2', 'c:3']);

    expect(sql).toHaveLength(1); // one statement — no per-contract N+1
    expect(sql[0]).toContain('JOIN amendments am');
    expect(sql[0]).toContain('IN (?, ?, ?)'); // placeholder per id, bounded by the leaderboard
    expect(bound[0]).toEqual(['c:1', 'c:2', 'c:3']);
  });

  it('normalises BGN amendment values to EUR (peg) and keeps the reason', async () => {
    const { db } = fakeAnnexDb([annexRaw()]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    expect(a!.contractId).toBe('c:123');
    expect(a!.date).toBe('2023-05-01');
    expect(a!.reason).toBe('Допълнителни количества СМР');
    expect(a!.valueBeforeEur).toBeCloseTo(1_000_000 / 1.95583, 2);
    expect(a!.valueAfterEur).toBeCloseTo(1_300_000 / 1.95583, 2);
    expect(a!.deltaEur).toBeCloseTo(300_000 / 1.95583, 2);
  });

  it('passes EUR values through unconverted', async () => {
    const { db } = fakeAnnexDb([
      annexRaw({ currency: 'EUR', value_before: 500, value_after: 800, value_delta: 300 }),
    ]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    expect(a!.deltaEur).toBe(300);
    expect(a!.valueAfterEur).toBe(800);
  });

  it('derives the delta from before/after when value_delta is NULL', async () => {
    const { db } = fakeAnnexDb([
      annexRaw({ currency: 'EUR', value_before: 500, value_after: 800, value_delta: null }),
    ]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    expect(a!.deltaEur).toBe(300);
  });

  it('keeps a reducing amendment negative (the history carries decreases too)', async () => {
    const { db } = fakeAnnexDb([
      annexRaw({ currency: 'EUR', value_before: 800, value_after: 700, value_delta: -100 }),
    ]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    // A negative delta — the route prefixes „+" only when deltaEur > 0, so this renders „−100 €".
    expect(a!.deltaEur).toBe(-100);
  });

  it('omits the EUR figure for a currency without an fx rate', async () => {
    const { db } = fakeAnnexDb([
      annexRaw({ currency: 'USD', value_before: 500, value_after: 800, value_delta: 300 }),
    ]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    expect(a!.deltaEur).toBeNull();
    expect(a!.valueBeforeEur).toBeNull();
    expect(a!.valueAfterEur).toBeNull();
  });

  it('keeps a missing reason honest (NULL, not an empty string)', async () => {
    const { db } = fakeAnnexDb([annexRaw({ description: '   ' })]);

    const [a] = await getOverrunAnnexes(db, ['c:123']);

    expect(a!.reason).toBeNull();
  });
});

describe('getOverrunsHeadline', () => {
  // One statement, one row out: the two figures the /analytics card shows.
  function fakeDb(row: { total_overrun_eur: number; median_pct: number } | null): D1Database {
    return {
      prepare() {
        return {
          async first<T>() {
            return row as T;
          },
        };
      },
    } as unknown as D1Database;
  }

  it('returns the corpus total overrun and median growth pct', async () => {
    const h = await getOverrunsHeadline(fakeDb({ total_overrun_eur: 4200000, median_pct: 2.1 }));
    expect(h).toEqual({ totalOverrunEur: 4200000, medianPct: 2.1 });
  });

  it('defaults to zeroes when the corpus is empty', async () => {
    const h = await getOverrunsHeadline(fakeDb(null));
    expect(h).toEqual({ totalOverrunEur: 0, medianPct: 0 });
  });
});
