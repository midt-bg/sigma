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
  assertSameFinalHost,
  findFxCoverageGaps,
  fxSeriesUrl,
  isCurrencyCode,
  isIsoDate,
  loadFxRates,
  parseFxSeries,
} from './fx';
import { d1FromSqlite } from '@sigma/test-support';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FETCHED_AT = '2026-07-10T00:00:00Z';

function fxDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(root, 'packages/db/migrations/0000_init.sql'), 'utf8'));
  db.exec(
    readFileSync(resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql'), 'utf8'),
  );
  db.exec(
    readFileSync(resolve(root, 'packages/db/migrations/0029_contract_value_evidence.sql'), 'utf8'),
  );
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

function seriesResponse(rates: Record<string, { EUR: number }>, base = 'USD'): Response {
  const dates = Object.keys(rates).sort();
  return Response.json({ amount: 1, base, start_date: dates[0], end_date: dates.at(-1), rates });
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

  const request = {
    base: 'USD',
    quote: 'EUR',
    amount: 1,
    start: '2026-06-28',
    end: '2026-07-08',
  } as const;
  const series = {
    amount: 1,
    base: 'USD',
    start_date: '2026-07-07',
    end_date: '2026-07-07',
    rates: { '2026-07-07': { EUR: 0.87 } },
  };

  it('parses a complete pair and a structurally valid empty map', () => {
    expect(parseFxSeries(series, request)).toEqual([
      { currency: 'USD', rateDate: '2026-07-07', eurPerUnit: 0.87 },
    ]);
    expect(parseFxSeries({ rates: {} }, request)).toEqual([]);
  });

  it('accepts the provider’s Friday observation for a weekend-only range', () => {
    const friday = '2026-06-05';
    const weekend = { ...request, start: '2026-06-06', end: '2026-06-07' };
    const payload = {
      ...series,
      start_date: friday,
      end_date: friday,
      rates: { [friday]: { EUR: 0.85911 } },
    };
    expect(parseFxSeries(payload, weekend)).toEqual([
      { currency: 'USD', rateDate: friday, eurPerUnit: 0.85911 },
    ]);
    const monday = '2026-06-08';
    expect(
      parseFxSeries(
        {
          ...payload,
          end_date: monday,
          rates: { ...payload.rates, [monday]: { EUR: 0.86655 } },
        },
        { ...weekend, end: monday },
      ),
    ).toHaveLength(2);
  });

  it('rejects a malformed success series in full, even if it contains usable observations', () => {
    const malformed = [
      null,
      42,
      'x',
      [],
      {},
      { message: 'unavailable' },
      { rates: null },
      { rates: 'x' },
      { rates: [] },
      { rates: {}, base: 'CAD' },
      { rates: {}, amount: 2 },
      { rates: {}, start_date: '2026-02-29' },
      { rates: {}, end_date: '2026-02-29' },
      { rates: {}, end_date: '2026-07-09' },
      { rates: {}, start_date: '2026-07-08', end_date: '2026-07-07' },
      { ...series, base: undefined },
      { ...series, base: 'CAD' },
      { ...series, amount: undefined },
      { ...series, amount: 2 },
      { ...series, start_date: undefined },
      { ...series, end_date: undefined },
      { ...series, start_date: '2026-07-08', end_date: '2026-07-06' },
      { ...series, start_date: '2026-07-06' },
      { ...series, end_date: '2026-07-08' },
      { ...series, start_date: '2026-07-08', end_date: '2026-07-08' },
      {
        ...series,
        start_date: '2026-06-31',
        rates: { ...series.rates, '2026-06-31': { EUR: 0.8 } },
      },
      {
        ...series,
        start_date: '2026-06-30',
        rates: { ...series.rates, '2026-06-30': { EUR: 0.8 }, '2026-06-31': { EUR: 0.8 } },
      },
      { ...series, rates: { ...series.rates, '2026-07-09': { EUR: 0.33 } } },
      {
        ...series,
        end_date: '2026-07-09',
        rates: { ...series.rates, '2026-07-09': { EUR: 0.33 } },
      },
      {
        ...series,
        start_date: '2026-06-25',
        rates: { ...series.rates, '2026-06-25': { EUR: 0.33 }, '2026-06-26': { EUR: 0.33 } },
      },
      {
        ...series,
        start_date: '2026-06-26',
        rates: { ...series.rates, '2026-06-26': { EUR: 0.33 }, '2026-06-28': { EUR: 0.33 } },
      },
      ...[
        null,
        [],
        [0.8],
        {},
        { CAD: 0.8 },
        { EUR: 0.8, CAD: 0.6 },
        ...['0.8', [0.8], true, null, -1, 0, Infinity, NaN].map((EUR) => ({ EUR })),
      ].map((quote) => ({ ...series, rates: { '2026-07-07': quote } })),
    ];
    for (const payload of malformed) {
      expect(() => parseFxSeries(payload, request)).toThrow(
        /malformed FX series for USD 2026-06-28\.\.2026-07-08/,
      );
    }
  });

  it('assertSameFinalHost rejects a cross-host redirect and accepts same-host/empty', () => {
    expect(() =>
      assertSameFinalHost('https://api.frankfurter.app/x', 'https://evil.example/x'),
    ).toThrow(/blocked redirected FX fetch from api\.frankfurter\.app to evil\.example/);
    expect(() =>
      assertSameFinalHost('https://api.frankfurter.app/x', 'https://api.frankfurter.app/y'),
    ).not.toThrow();
    expect(() => assertSameFinalHost('https://api.frankfurter.app/x', '')).not.toThrow();
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

  it('finds a foreign annex quote at the signing date of a staged or served contract', async () => {
    const { db, d1 } = fxDb();
    db.exec(`
      INSERT INTO raw_contracts (source, fetched_at, unp, contract_number, contract_date, currency)
      VALUES ('eop:contracts:2026-07-09', '2026-07-09', 'TEST-NEW', 'NEW', '2026-07-08', 'EUR');

      INSERT INTO authorities (id, name) VALUES ('auth:test', 'Община Тест');
      INSERT INTO bidders (id, name) VALUES ('bidder:test', 'ТЕСТ ГРУП ЕООД');
      INSERT INTO tenders (id, source_id, title, authority_id, procedure_type, status)
        VALUES ('t:TEST-OLD', 'TEST-OLD', 'Тестова поръчка', 'auth:test', 'open', 'awarded');
      INSERT INTO contracts (id, tender_id, bidder_id, contract_number, amount, currency, signed_at)
        VALUES ('c:e:test', 't:TEST-OLD', 'bidder:test', 'OLD', 10000, 'BGN', '2025-06-10');

      INSERT INTO raw_amendments (source, fetched_at, unp, contract_number, published_at, value_after, currency)
      VALUES
        ('eop:annexes:2026-07-09', '2026-07-09', 'TEST-NEW', 'NEW', '2026-07-09', 15000, 'USD'),
        ('eop:annexes:2026-07-09', '2026-07-09', 'TEST-OLD', 'OLD', '2026-07-09', 15000, 'CHF');
    `);
    insertRate(db, 'CHF', '2026-07-09', 0.95);
    expect(await findFxCoverageGaps(d1)).toEqual([
      { currency: 'CHF', minDate: '2025-06-10', maxDate: '2025-06-10', missingDates: 1 },
      { currency: 'USD', minDate: '2026-07-08', maxDate: '2026-07-08', missingDates: 1 },
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

  it('skips a coverage gap whose staged contract_date is not a valid ISO date', async () => {
    // A malformed date in raw staging surfaces verbatim through findFxCoverageGaps' MIN/MAX (the SQL
    // does not format-validate), so loadFxRates must reject the range before fetching.
    const { db, d1 } = fxDb();
    stageContract(db, 'CHF', '2026-7-8'); // unpadded → isIsoDate false
    const fetchFn = vi.fn();

    const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });

    expect(fetchFn).not.toHaveBeenCalled(); // never fetches for an unusable range
    expect(summary.skipped).toContain('CHF');
    expect(summary.warnings.some((w) => w.includes('invalid date range'))).toBe(true);
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

  // Same defect class as the EOP reads: a body that is never read holds its stream open for the rest
  // of the invocation. The 404 path is the most-travelled one here — Frankfurter answers 404 for any
  // base currency it does not serve, and the loader deliberately continues past it.
  it('releases the body of every response it walks away from', async () => {
    const openBody = () => {
      let cancelled = false;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('x'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return { body, cancelled: () => cancelled };
    };

    // 404 — unsupported currency, the loader warns and moves on.
    {
      const { db, d1 } = fxDb();
      stageContract(db, 'USD', '2026-07-08');
      const b = openBody();
      const fetchFn = vi.fn(
        async () => new Response(b.body, { status: 404 }),
      ) as unknown as typeof fetch;
      const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
      expect(summary.warnings.join(' ')).toMatch(/not served by frankfurter/);
      expect(b.cancelled()).toBe(true);
    }

    // Non-OK — the loader throws.
    {
      const { db, d1 } = fxDb();
      stageContract(db, 'USD', '2026-07-08');
      const b = openBody();
      const fetchFn = vi.fn(
        async () => new Response(b.body, { status: 500 }),
      ) as unknown as typeof fetch;
      await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(/HTTP 500/);
      expect(b.cancelled()).toBe(true);
    }

    // Redirected to another host — the host pin throws.
    {
      const { db, d1 } = fxDb();
      stageContract(db, 'USD', '2026-07-08');
      const b = openBody();
      const fetchFn = vi.fn(async () => {
        const res = new Response(b.body, { status: 200 });
        Object.defineProperty(res, 'url', {
          value: 'https://evil.example/v1/2026-07-01..2026-07-08',
        });
        return res;
      }) as unknown as typeof fetch;
      await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow();
      expect(b.cancelled()).toBe(true);
    }
  });

  it('keeps successfully loaded currencies when another currency fails', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'CHF', '2026-07-08');
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('base=CHF')) {
        return seriesResponse({ '2026-07-07': { EUR: 1.05 } }, 'CHF');
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

  it('rejects malformed USD even when CAD succeeds and preserves stored rates for retry', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    stageContract(db, 'CAD', '2026-07-08');
    insertRate(db, 'USD', '2026-06-01', 0.8);
    const fetchFn = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('base=CAD')
        ? seriesResponse({ '2026-07-07': { EUR: 0.6 } }, 'CAD')
        : Response.json({
            amount: 1,
            base: 'USD',
            start_date: '2026-06-01',
            end_date: '2026-07-09',
            rates: { '2026-06-01': { EUR: 0.33 }, '2026-07-09': { EUR: 0.33 } },
          }),
    );
    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(
      /malformed FX series for USD/,
    );
    const quotes = () =>
      db
        .prepare(
          'SELECT base_currency, eur_per_unit FROM fx_rates ORDER BY base_currency, rate_date',
        )
        .all();
    expect(quotes()).toEqual([
      { base_currency: 'CAD', eur_per_unit: 0.6 },
      { base_currency: 'USD', eur_per_unit: 0.8 },
    ]);
    fetchFn.mockResolvedValueOnce(seriesResponse({ '2026-07-07': { EUR: 0.87 } }));
    const retry = await loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn });
    expect(retry.fetched.map((f) => f.currency)).toEqual(['USD']);
    expect(retry.uncovered).toEqual([]);
  });

  it('refuses rates from a cross-host redirect and fails closed while the gap remains', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn(async () => {
      const res = seriesResponse({ '2026-07-07': { EUR: 0.01 } });
      Object.defineProperty(res, 'url', { value: 'https://evil.example/2026-06-28..2026-07-08' });
      return res;
    }) as unknown as typeof fetch;

    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(FxLoadError);
    const count = db.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number };
    expect(count.n).toBe(0);
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

describe('loadFxRates — default fetch and non-Error failures', () => {
  it('uses the global fetch when none is injected', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn(async () => seriesResponse({ '2026-07-07': { EUR: 0.87 } }));
    vi.stubGlobal('fetch', fetchFn);
    try {
      const summary = await loadFxRates(d1, { fetchedAt: FETCHED_AT });
      expect(fetchFn).toHaveBeenCalledWith(fxSeriesUrl('USD', '2026-06-28', '2026-07-08'));
      expect(summary).toMatchObject({ inserted: 1, uncovered: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a failure thrown as a bare value by its text', async () => {
    const { db, d1 } = fxDb();
    stageContract(db, 'USD', '2026-07-08');
    const fetchFn = vi.fn().mockRejectedValue('connection reset') as unknown as typeof fetch;
    await expect(loadFxRates(d1, { fetchedAt: FETCHED_AT, fetchFn })).rejects.toThrow(
      /USD 2026-07-08\.\.2026-07-08 \(1 dates\): connection reset/,
    );
  });
});
