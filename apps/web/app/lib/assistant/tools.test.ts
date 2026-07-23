import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  DEFAULT_ROWS_READ_BUDGET,
  finalizeReport,
  resolveRowsReadBudget,
  runTool,
  type ToolContext,
} from './tools';

function ctx(
  rows: Record<string, string | number | null>[] = [],
  opts: { rowsRead?: number; rowsReadBudget?: number; totalAttempts?: number } = {},
): ToolContext {
  const db = {
    prepare(_sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return {
            results: rows as T[],
            meta: { rows_read: opts.rowsRead ?? 0, total_attempts: opts.totalAttempts ?? 1 },
          };
        },
        async first<T>() {
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
  return { db, results: [], rowsRead: 0, rowsReadBudget: opts.rowsReadBudget };
}

describe('the tool registry', () => {
  it('exposes the read-only/source tools the model may call', () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name).sort()).toEqual([
      'describe_schema',
      'eop_fetch',
      'run_sql',
      'semantic_search',
      'source_link',
    ]);
  });

  it('describe_schema returns the data dictionary', async () => {
    expect(await runTool('describe_schema', {}, ctx())).toContain('Речник на данните');
  });

  it('dispatches an unknown tool safely', async () => {
    expect(await runTool('rm_rf', {}, ctx())).toMatch(/Непознат инструмент/);
  });
});

describe('run_sql', () => {
  it('runs a SELECT, retains the result under a handle, and returns a compact view', async () => {
    const c = ctx([{ total_eur: 2124567 }]);
    const out = await runTool(
      'run_sql',
      { sql: 'SELECT SUM(amount_eur) AS total_eur FROM contracts' },
      c,
    );
    expect(out).toContain('R1');
    expect(c.results).toHaveLength(1);
    expect(c.results[0]).toMatchObject({ handle: 'R1', columns: ['total_eur'], rows: [[2124567]] });
  });

  it('rejects a non-read-only statement and retains nothing', async () => {
    const c = ctx();
    const out = await runTool('run_sql', { sql: 'UPDATE contracts SET amount_eur = 0' }, c);
    expect(out).toMatch(/отхвърлена/);
    expect(c.results).toHaveLength(0);
  });

  it('accumulates D1 rows_read across the turn (issue #122)', async () => {
    const c = ctx([{ n: 1 }], { rowsRead: 250 });
    await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    expect(c.rowsRead).toBe(500);
  });

  it('multiplies rows_read by total_attempts so a D1-retried full scan is not under-billed (review #80)', async () => {
    // meta.rows_read is the LAST attempt only; a query D1 auto-retried scanned the table on each attempt.
    // Without the ×total_attempts factor a retried full scan under-bills the Denial-of-Wallet budget.
    const c = ctx([{ n: 1 }], { rowsRead: 100, totalAttempts: 3 });
    await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    expect(c.rowsRead).toBe(300); // 100 × 3, not 100
  });

  it('refuses further run_sql once the per-turn rows-read budget is exceeded (issue #122)', async () => {
    // Budget 500, each query reports 1000 rows read. The first runs (accumulated 0 < 500) and pushes
    // the turn total to 1000, so the second is refused before it reaches the DB.
    const c = ctx([{ n: 1 }], { rowsRead: 1000, rowsReadBudget: 500 });
    expect(await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c)).toContain('R1');
    const refused = await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    expect(refused).toMatch(/прочетени редове/);
    expect(c.results).toHaveLength(1);
  });
});

describe('semantic_search', () => {
  it('degrades gracefully when the AI/Vectorize bindings are absent', async () => {
    expect(await runTool('semantic_search', { query: 'детски градини' }, ctx())).toMatch(
      /не е налично/,
    );
  });

  it('degrades gracefully when embedding throws instead of surfacing the raw error (review #80)', async () => {
    const c = ctx();
    c.ai = {
      run: async () => {
        throw new Error('AI down');
      },
    } as unknown as NonNullable<ToolContext['ai']>;
    c.vectorize = {
      upsert: async () => ({}),
      query: async () => ({ matches: [] }),
    } as unknown as NonNullable<ToolContext['vectorize']>;
    expect(await runTool('semantic_search', { query: 'x' }, c)).toMatch(/не е налично/);
  });
});

describe('finalizeReport', () => {
  it('binds a report from this turn’s retained results', () => {
    const c = ctx();
    c.results.push({ handle: 'R1', columns: ['total_eur'], rows: [[2124567]] });
    const out = finalizeReport(
      {
        title: 'Общо',
        question: 'колко общо?',
        blocks: [
          {
            type: 'totals',
            items: [
              { label: 'Общо', ref: { resultId: 'R1', row: 0, col: 'total_eur' }, format: 'money' },
            ],
          },
        ],
      },
      c,
    );
    expect(out.ok).toBe(true);
  });

  it('rejects a structurally invalid report before binding', () => {
    const out = finalizeReport({ title: '', question: '', blocks: [] }, ctx());
    expect(out.ok).toBe(false);
  });

  it('uses the server-provided user question over the model echo (review #80)', () => {
    const c = ctx();
    c.userQuestion = 'кои са топ 5?';
    c.results.push({ handle: 'R1', columns: ['total_eur'], rows: [[1]] });
    const out = finalizeReport(
      { title: 't', question: 'усвоени 12 млрд', blocks: [{ type: 'text', md: 'ок' }] },
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.question).toBe('кои са топ 5?');
  });

  it('rejects a report referencing a handle that was never produced this turn', () => {
    const out = finalizeReport(
      {
        title: 't',
        question: '',
        blocks: [
          {
            type: 'totals',
            items: [{ label: 'x', ref: { resultId: 'R7', row: 0, col: 'c' }, format: 'money' }],
          },
        ],
      },
      ctx(),
    );
    expect(out.ok).toBe(false);
  });
});

describe('resolveRowsReadBudget', () => {
  it('defaults on missing/invalid input and clamps to the ceiling', () => {
    expect(resolveRowsReadBudget(undefined)).toBe(DEFAULT_ROWS_READ_BUDGET);
    expect(resolveRowsReadBudget('0')).toBe(DEFAULT_ROWS_READ_BUDGET);
    expect(resolveRowsReadBudget('not-a-number')).toBe(DEFAULT_ROWS_READ_BUDGET);
    expect(resolveRowsReadBudget('1000000')).toBe(1_000_000);
    expect(resolveRowsReadBudget('999999999')).toBe(50_000_000);
  });
});

describe('run_sql — guard and error paths', () => {
  it('rejects a structurally-valid SELECT over a non-allowlisted table (AST guard)', async () => {
    // Passes the cheap structural read-only check, then the AST guard rejects the raw_* mirror.
    const c = ctx();
    const out = await runTool('run_sql', { sql: 'SELECT id FROM raw_contracts' }, c);
    expect(out).toMatch(/отхвърлена/);
    expect(c.results).toHaveLength(0);
  });

  it('tolerates a driver that omits rows-read meta and an unset turn counter', async () => {
    const c: ToolContext = {
      db: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              return { results: [{ n: 1 }] }; // no meta block
            },
          };
        },
      } as unknown as D1Database,
      results: [], // rowsRead intentionally unset → the `?? 0` fallback
    };
    const out = await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    expect(out).toContain('R1');
    expect(c.rowsRead).toBe(0); // meta absent → +0
  });

  it('tolerates a driver that returns no results array at all (results ?? [])', async () => {
    const c: ToolContext = {
      db: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              return {}; // neither results nor meta
            },
          };
        },
      } as unknown as D1Database,
      results: [],
    };
    const out = await runTool('run_sql', { sql: 'SELECT n FROM contracts' }, c);
    expect(out).toContain('R1'); // an empty result set, still handled
    expect(c.results[0]).toMatchObject({ rows: [] });
  });

  it('returns a generic error (never the raw D1 message) when the query throws', async () => {
    const c: ToolContext = {
      db: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all() {
              throw new Error('D1 internal: table x locked');
            },
          };
        },
      } as unknown as D1Database,
      results: [],
      rowsRead: 0,
    };
    const out = await runTool('run_sql', { sql: 'SELECT 1 AS n FROM contracts' }, c);
    expect(out).toBe('Грешка при изпълнение на заявката.');
    expect(out).not.toContain('D1 internal');
  });
});

describe('semantic_search — hits', () => {
  function vectorCtx(
    matches: { id: string; score: number; metadata?: Record<string, unknown> }[],
  ): ToolContext {
    return {
      db: {} as D1Database,
      results: [],
      ai: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) } as unknown as NonNullable<
        ToolContext['ai']
      >,
      vectorize: {
        upsert: async () => ({}),
        query: async () => ({ matches }),
      } as unknown as NonNullable<ToolContext['vectorize']>,
    };
  }

  it('formats semantic hits with kind, ref, title and score', async () => {
    const c = vectorCtx([
      {
        id: 'entity:1',
        score: 0.912,
        metadata: { kind: 'company', ref: 'eik:1', title: 'Тест ООД' },
      },
    ]);
    const out = await runTool('semantic_search', { query: 'детски градини' }, c);
    expect(out).toContain('company eik:1 — Тест ООД (0.912)');
  });

  it('reports no matches when the vector index returns none', async () => {
    const out = await runTool('semantic_search', { query: 'нищо' }, vectorCtx([]));
    expect(out).toMatch(/Няма семантични съвпадения/);
  });
});

describe('eop_fetch', () => {
  it('rejects a malformed date without fetching', async () => {
    const out = await runTool('eop_fetch', { date: 'nonsense' }, ctx());
    expect(out).toMatch(/Невалидна дата/);
  });

  it('summarises per-file row counts and errors, flagging the data as non-bindable', async () => {
    let call = 0;
    const c: ToolContext = {
      db: {} as D1Database,
      results: [],
      fetchImpl: async () => {
        call++;
        // First file: a valid JSON array; the rest: a 403 surfaced as a per-file error.
        return call === 1
          ? {
              ok: true,
              status: 200,
              headers: { get: () => null },
              text: async () => JSON.stringify([{ a: 1 }, { a: 2 }]),
            }
          : { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
      },
    };
    const out = await runTool('eop_fetch', { date: '2024-01-15' }, c);
    expect(out).toMatch(/2 реда/); // the valid file's row count
    expect(out).toMatch(/грешка \(HTTP 403\)/); // a missing file surfaced as an error
    expect(out).toContain('не могат да се подават към emit_report'); // non-bindable note
  });

  it('falls back to the global fetch when the context supplies no fetch impl', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => '',
    })) as unknown as typeof fetch;
    try {
      const out = await runTool('eop_fetch', { date: '2024-01-15' }, ctx()); // ctx() has no fetchImpl
      expect(out).toMatch(/HTTP 403/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('source_link', () => {
  it('returns official deep links for a tender id', async () => {
    const out = await runTool('source_link', { eopTenderId: '00123-2024-0007' }, ctx());
    expect(out).toMatch(/https?:\/\//);
  });

  it('reports no links when the input yields none', async () => {
    expect(await runTool('source_link', {}, ctx())).toMatch(/Няма налични официални линкове/);
  });
});
