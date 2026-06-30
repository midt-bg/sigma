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
