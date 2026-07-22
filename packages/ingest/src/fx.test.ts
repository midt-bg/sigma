/// <reference types="node" />
// Unit + integration tests for the shared FX logic (#158): pure pieces (URL, parsing, date math)
// and the Worker-native loader's full fail-mode matrix against a real SQLite behind the D1 facade.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  FRANKFURTER_API,
  FX_LOOKBACK_DAYS,
  FX_SOURCE,
  FxLoadError,
  addDays,
  findFxCoverageGaps,
  fxSeriesUrl,
  isCurrencyCode,
  isIsoDate,
  loadFxRates,
  parseFxSeries,
} from './fx';
import { d1FromSqlite } from './test/d1-sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FETCHED_AT = '2026-07-10T00:00:00Z';

function fxDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(root, 'packages/db/migrations/0000_init.sql'), 'utf8'));
  db.exec(readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8'));
  return { db, d1: d1FromSqlite(db) };
}

function stageContract(
  db: DatabaseSync,
  currency: string,
  contractDate: string,
  source = 'eop:contracts:2026-07-09',
): void {
  db.prepare(
    `INSERT INTO raw_contracts (source, fetched_at, contract_number, contract_date, currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(source, FETCHED_AT, `C-${currency}-${contractDate}`, contractDate, currency);
}

function insertRate(db: DatabaseSync, currency: string, rateDate: string, rate: number): void {
  db.prepare(
    'INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES (?, ?, ?, ?, ?)',
  ).run(currency, rateDate, rate, FX_SOURCE, FETCHED_AT);
}

function seriesResponse(rates: Record<string, { EUR: number }>): Response {
  return new Response(JSON.stringify({ rates }), { status: 200 });
}

describe('pure fx helpers', () => {
  it('validates ISO dates and currency codes', () => {
    expect(isIsoDate('2026-07-08')).toBe(true);
    expect(isIsoDate('2026-7-8')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('US')).toBe(false);
    expect(isCurrencyCode('U$D')).toBe(false);
  });

  it('addDays crosses month and year boundaries in UTC', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-05', -10)).toBe('2025-12-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('builds the frankfurter time-series URL with encoding', () => {
    expect(fxSeriesUrl('USD', '2026-06-28', '2026-07-08')).toBe(
      `${FRANKFURTER_API}/2026-06-28..2026-07-08?base=USD&symbols=EUR`,
    );
    expect(fxSeriesUrl('USD', '2026-06-28', '2026-07-08', 'https://mock.test')).toContain(
      'https://mock.test/',
    );
  });

  it('parseFxSeries keeps valid entries and warns on malformed ones', () => {
    const { rows, warnings } = parseFxSeries(
      {
        rates: {
          '2026-07-07': { EUR: 0.87 },
          'not-a-date': { EUR: 0.9 },
          '2026-07-08': { EUR: 'oops' },
          '2026-07-09': { EUR: -1 },
          '2026-07-10': null,
        },
      },
      'USD',
    );
    expect(rows).toEqual([{ currency: 'USD', rateDate: '2026-07-07', eurPerUnit: 0.87 }]);
    expect(warnings).toHaveLength(4);
  });

  it('parseFxSeries warns on a payload without a rates object', () => {
    for (const payload of [null, 42, 'x', {}, { rates: null }, { rates: 'x' }]) {
      const { rows, warnings } = parseFxSeries(payload, 'USD');
      expect(rows).toEqual([]);
      expect(warnings).toEqual(['no rate series for USD']);
    }
  });
});

describe('findFxCoverageGaps', () => {
  it('honours the exact derive lookback bound', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'CHF', '2026-07-08');
    // USD: rate exactly FX_LOOKBACK_DAYS before the contract date → still usable (covered).
    insertRate(db, 'USD', addDays('2026-07-08', -FX_LOOKBACK_DAYS), 0.87);
    // CHF: rate one day beyond the lookback → unusable, must surface as a gap.
    insertRate(db, 'CHF', addDays('2026-07-08', -(FX_LOOKBACK_DAYS + 1)), 1.05);

    const gaps = await findFxCoverageGaps(d1);
    expect(gaps).toEqual([
      { currency: 'CHF', minDate: '2026-07-08', maxDate: '2026-07-08', missingDates: 1 },
    ]);
  });

  it('ignores BGN/EUR, NULL dates and non-EOP/OCDS sources', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'BGN', '2026-07-08');
    stageContract(db, 'EUR', '2026-07-08');
    stageContract(db, 'USD', '2026-07-08', 'other:feed');
    db.prepare(
      `INSERT INTO raw_contracts (source, fetched_at, contract_number, currency)
       VALUES ('eop:contracts:2026-07-09', ?, 'C-NODATE', 'USD')`,
    ).run(FETCHED_AT);

    expect(await findFxCoverageGaps(d1)).toEqual([]);
  });
});

describe('loadFxRates', () => {
  it('does not fetch at all when coverage is already complete', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    insertRate(db, 'USD', '2026-07-07', 0.87);
    const fetchFn = vi.fn();

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary).toEqual({ fetched: [], skipped: [], inserted: 0, uncovered: [], warnings: [] });
  });

  it('fetches only the gap range and upserts rates idempotently', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        fxSeriesUrl('USD', addDays('2026-07-08', -FX_LOOKBACK_DAYS), '2026-07-08'),
      );
      return seriesResponse({ '2026-07-04': { EUR: 0.86 }, '2026-07-07': { EUR: 0.87 } });
    }) as unknown as typeof fetch;

    const first = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(first.inserted).toBe(2);
    expect(first.fetched).toEqual([
      { currency: 'USD', start: '2026-06-28', end: '2026-07-08', loaded: 2, status: 'ok' },
    ]);
    expect(first.uncovered).toEqual([]);

    // Re-run: coverage now complete → no second fetch, no duplicate rows.
    const second = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(second.inserted).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('throws FxLoadError when the fetch fails and the gap remains (fail loudly, not NULL)', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(FxLoadError);
    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(
      /USD 2026-07-08\.\.2026-07-08 \(1 dates\)/,
    );
  });

  it('treats a non-404 HTTP error as a failed fetch', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(/HTTP 500/);
  });

  it('keeps successfully loaded currencies when another currency fails', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'CHF', '2026-07-08');
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('base=CHF')) {
        return seriesResponse({ '2026-07-07': { EUR: 1.05 } });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(/USD/);
    // CHF's rates landed before the throw — the retry only needs to repair USD.
    const chf = db
      .prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE base_currency = 'CHF'")
      .get() as { n: number };
    expect(chf.n).toBe(1);
    const retryFetch = vi.fn(async () =>
      seriesResponse({ '2026-07-07': { EUR: 0.87 } }),
    ) as unknown as typeof fetch;
    const retry = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn: retryFetch });
    expect(retry.fetched.map((f) => f.currency)).toEqual(['USD']);
    expect(retry.uncovered).toEqual([]);
  });

  it('warns and proceeds when frankfurter does not serve the currency (404)', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'XXX', '2026-07-08');
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    ) as unknown as typeof fetch;

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(summary.fetched[0]?.status).toBe('unsupported');
    expect(summary.uncovered).toHaveLength(1);
    expect(summary.warnings).toContain('currency XXX not served by frankfurter');
  });

  it('warns and proceeds when the fetch succeeds but ECB has no rates in range', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '1995-01-10');
    const fetchFn = vi.fn(async () => seriesResponse({})) as unknown as typeof fetch;

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(summary.inserted).toBe(0);
    expect(summary.uncovered).toEqual([
      { currency: 'USD', minDate: '1995-01-10', maxDate: '1995-01-10', missingDates: 1 },
    ]);
  });

  it('skips syntactically invalid staged currencies without fetching', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'usd', '2026-07-08');
    const fetchFn = vi.fn();

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual(['usd']);
    expect(summary.warnings).toEqual(['invalid currency usd']);
  });

  it('replaces overlapping already-loaded rates instead of erroring (upsert)', async () => {
    const { db, d1 } = fxDb();
    // Two gap dates far apart → one fetch range that spans an existing row which covers neither.
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'USD', '2026-08-15');
    insertRate(db, 'USD', '2026-07-20', 0.8);
    const fetchFn = vi.fn(async () =>
      seriesResponse({
        '2026-07-07': { EUR: 0.87 },
        '2026-07-20': { EUR: 0.88 },
        '2026-08-14': { EUR: 0.89 },
      }),
    ) as unknown as typeof fetch;

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(summary.uncovered).toEqual([]);
    const overlapped = db
      .prepare(
        "SELECT eur_per_unit FROM fx_rates WHERE base_currency = 'USD' AND rate_date = '2026-07-20'",
      )
      .get() as { eur_per_unit: number };
    expect(overlapped.eur_per_unit).toBe(0.88);
  });

  it('batches large rate series through the D1 facade without loss', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'USD', '2020-01-15');
    const rates: Record<string, { EUR: number }> = {};
    // ~1650 business days across the gap range — forces multiple upsert chunks.
    for (let d = '2020-01-06'; d <= '2026-07-08'; d = addDays(d, 1)) {
      rates[d] = { EUR: 0.9 };
    }
    const fetchFn = vi.fn(async () => seriesResponse(rates)) as unknown as typeof fetch;

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    const count = db.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number };
    expect(count.n).toBe(Object.keys(rates).length);
    expect(summary.inserted).toBe(Object.keys(rates).length);
    expect(summary.uncovered).toEqual([]);
  });
});
