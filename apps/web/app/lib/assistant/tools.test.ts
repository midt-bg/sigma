import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  DEFAULT_ROWS_READ_BUDGET,
  DEFAULT_SQL_TIMEOUT_MS,
  finalizeReport,
  resolveRowsReadBudget,
  resolveSqlTimeoutMs,
  runTool,
  type ToolContext,
} from './tools';

// A base-`contracts` query that carries BOTH default filters, so it clears the E3 default-filter gate
// (assert-default-filters.ts). Reused wherever a test needs a valid base-contracts run.
const CONTRACTS_WITH_DEFAULTS =
  'SELECT SUM(amount_eur) AS total_eur FROM contracts ' +
  "WHERE amount_eur IS NOT NULL AND procedure_type != 'неизвестна'";

// A rollup-only query — it never reads base `contracts`, so it BYPASSES the default-filter gate.
const ROLLUP_QUERY = 'SELECT total_eur AS n FROM sector_totals';

function ctx(
  rows: Record<string, string | number | null>[] = [],
  opts: {
    rowsRead?: number;
    rowsReadBudget?: number;
    totalAttempts?: number;
    // EXPLAIN-plan rows the mock returns for the opcode guard's `EXPLAIN <sql>` probe. Defaults to a
    // benign all-allowlisted READ plan so every non-write query passes; override with a write opcode to
    // exercise the guard's reject path (Unit 8).
    explainPlan?: { opcode: string }[];
    // When set, the REAL query's `.all()` never resolves — exercises the §9.4 per-query timeout race.
    hang?: boolean;
    // Per-query timeout to place on the context (§9.4). Small values keep the timeout test fast.
    sqlTimeoutMs?: number;
  } = {},
): ToolContext {
  const explainPlan = opts.explainPlan ?? [
    { opcode: 'Init' },
    { opcode: 'ResultRow' },
    { opcode: 'Halt' },
  ];
  const db = {
    prepare(sql: string) {
      // The opcode guard issues a SECOND prepared statement, `EXPLAIN <sql>`, before the real query
      // (sql-opcode-guard.ts). Branch on it: the EXPLAIN probe returns the (benign or write) plan; the
      // real query returns the test rows + rows_read meta exactly as before.
      const isExplain = sql.startsWith('EXPLAIN ');
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (isExplain) {
            return { results: explainPlan as T[], meta: { rows_read: 0, total_attempts: 1 } };
          }
          // Simulate a query that never returns, so the §9.4 timeout race is what settles the call.
          if (opts.hang) return new Promise<{ results: T[]; meta: unknown }>(() => {});
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
  return {
    db,
    results: [],
    sources: [],
    rowsRead: 0,
    rowsReadBudget: opts.rowsReadBudget,
    sqlTimeoutMs: opts.sqlTimeoutMs,
  };
}

describe('the tool registry', () => {
  it('exposes the read-only/source tools the model may call', () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name).sort()).toEqual([
      'answer_directly',
      'describe_schema',
      'eop_fetch',
      'find_entity',
      'reconcile_rollup',
      'run_sql',
      'semantic_search',
      'source_link',
    ]);
  });

  it('answer_directly is a no-op escape hatch: nudges prose, touches no result state (#69 residual)', async () => {
    // A non-data turn (greeting/meta) must have a valid tool to satisfy the forced first step WITHOUT
    // landing a junk numeric result that the fallback would publish as a hollow „totals: 1" report.
    const c = ctx();
    const out = await runTool('answer_directly', {}, c);
    expect(out).toContain('директно'); // instructs the model to answer in prose
    // The load-bearing property: it leaves ctx.results/sources empty, so buildFallbackReport has nothing
    // to synthesize from and the no-data affordance path is taken instead.
    expect(c.results).toHaveLength(0);
    expect(c.sources).toHaveLength(0);
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
    const out = await runTool('run_sql', { sql: CONTRACTS_WITH_DEFAULTS }, c);
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
    await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(c.rowsRead).toBe(500);
  });

  it('multiplies rows_read by total_attempts so a D1-retried full scan is not under-billed (review #80)', async () => {
    // meta.rows_read is the LAST attempt only; a query D1 auto-retried scanned the table on each attempt.
    // Without the ×total_attempts factor a retried full scan under-bills the Denial-of-Wallet budget.
    const c = ctx([{ n: 1 }], { rowsRead: 100, totalAttempts: 3 });
    await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(c.rowsRead).toBe(300); // 100 × 3, not 100
  });

  it('refuses further run_sql once the per-turn rows-read budget is exceeded (issue #122)', async () => {
    // Budget 500, each query reports 1000 rows read. The first runs (accumulated 0 < 500) and pushes
    // the turn total to 1000, so the second is refused before it reaches the DB.
    const c = ctx([{ n: 1 }], { rowsRead: 1000, rowsReadBudget: 500 });
    expect(await runTool('run_sql', { sql: ROLLUP_QUERY }, c)).toContain('R1');
    const refused = await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(refused).toMatch(/прочетени редове/);
    expect(c.results).toHaveLength(1);
  });

  it('times out a query that never returns, retains nothing, and never leaks the cause (§9.4)', async () => {
    const c = ctx([{ n: 1 }], { hang: true, sqlTimeoutMs: 10 });
    const out = await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    // Generic error — the model must never learn the query stalled (no schema/timing disclosure).
    expect(out).toBe('Грешка при изпълнение на заявката.');
    expect(c.results).toHaveLength(0);
    expect(c.sources).toHaveLength(0);
  });
});

describe('resolveSqlTimeoutMs (§9.4)', () => {
  it('defaults on a missing / non-numeric / < 1 value', () => {
    expect(resolveSqlTimeoutMs(undefined)).toBe(DEFAULT_SQL_TIMEOUT_MS);
    expect(resolveSqlTimeoutMs('')).toBe(DEFAULT_SQL_TIMEOUT_MS);
    expect(resolveSqlTimeoutMs('abc')).toBe(DEFAULT_SQL_TIMEOUT_MS);
    expect(resolveSqlTimeoutMs('0')).toBe(DEFAULT_SQL_TIMEOUT_MS);
    expect(resolveSqlTimeoutMs('-5')).toBe(DEFAULT_SQL_TIMEOUT_MS);
  });

  it('clamps a valid value to [1000, 30000]', () => {
    expect(resolveSqlTimeoutMs('500')).toBe(1_000); // floor
    expect(resolveSqlTimeoutMs('5000')).toBe(5_000);
    expect(resolveSqlTimeoutMs('999999')).toBe(30_000); // ceiling
  });
});

describe('run_sql default-filter gate (E3, Unit 3)', () => {
  it('rejects a base-contracts query missing the default filters and retains nothing', async () => {
    const c = ctx([{ total_eur: 1 }]);
    const out = await runTool(
      'run_sql',
      { sql: 'SELECT SUM(amount_eur) AS total_eur FROM contracts' },
      c,
    );
    expect(out).toMatch(/^Заявката е отхвърлена/);
    expect(c.results).toHaveLength(0);
  });

  it('executes a base-contracts query carrying both defaults and stores a result handle', async () => {
    const c = ctx([{ total_eur: 2124567 }]);
    const out = await runTool('run_sql', { sql: CONTRACTS_WITH_DEFAULTS }, c);
    expect(out).toContain('R1');
    expect(c.results).toHaveLength(1);
  });

  it('leaves a rollup-only query unaffected by the gate', async () => {
    const c = ctx([{ n: 5 }]);
    const out = await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(out).toContain('R1');
  });
});

describe('run_sql opcode guard (Unit 8)', () => {
  it('rejects when the compiled plan carries a write opcode and does not execute', async () => {
    const c = ctx([{ n: 1 }], {
      explainPlan: [{ opcode: 'Init' }, { opcode: 'OpenWrite' }, { opcode: 'Halt' }],
    });
    const out = await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(out).toMatch(/^Заявката е отхвърлена/);
    expect(c.results).toHaveLength(0);
  });

  it('executes when the compiled plan is read-only', async () => {
    const c = ctx([{ n: 1 }]); // default benign read plan
    const out = await runTool('run_sql', { sql: ROLLUP_QUERY }, c);
    expect(out).toContain('R1');
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

describe('find_entity — Cyrillic-safe name → id resolution', () => {
  it('returns the exact join id per hit, labelled by kind (the СТОЛИЧНА ОБЩИНА case)', async () => {
    const c = ctx([
      { kind: 'authority', ref: '000696327', title: 'СТОЛИЧНА ОБЩИНА', ident: '000696327' },
      { kind: 'company', ref: '831646048', title: '"АВТОМАГИСТРАЛИ" ЕАД', ident: '831646048' },
    ]);
    // Title-case query that a case-sensitive LIKE would miss against the uppercase-stored name.
    const out = await runTool('find_entity', { name: 'Столична община' }, c);
    expect(out).toContain('възложител id=000696327 — СТОЛИЧНА ОБЩИНА');
    expect(out).toContain('изпълнител id=831646048 — "АВТОМАГИСТРАЛИ" ЕАД');
  });

  it('asks for a longer term when nothing searchable remains', async () => {
    expect(await runTool('find_entity', { name: 'а' }, ctx())).toMatch(/поне 2 знака/);
  });

  it('reports no match (not an error) when the FTS query returns nothing', async () => {
    expect(await runTool('find_entity', { name: 'несъществуваща организация' }, ctx([]))).toMatch(
      /Няма намерени субекти/,
    );
  });

  it('degrades gracefully if the FTS query throws', async () => {
    const c = ctx();
    c.db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            throw new Error('search_index missing');
          },
        };
      },
    } as unknown as D1Database;
    expect(await runTool('find_entity', { name: 'Столична община' }, c)).toMatch(/не е налично/);
  });
});

describe('reconcile_rollup (Unit 5)', () => {
  // R1 = the live aggregate the model computed; R2 = the precomputed rollup figure it must match.
  function withResults(
    live: [number, number] = [10, 1000],
    rollup: [number, number] = [10, 1000],
  ): ToolContext {
    const c = ctx();
    c.results.push({ handle: 'R1', columns: ['cnt', 'sum_eur'], rows: [live] });
    c.results.push({ handle: 'R2', columns: ['cnt', 'sum_eur'], rows: [rollup] });
    return c;
  }
  const refs = {
    grain: { division: '45', year: '2024' },
    aggregate: { resultId: 'R1', row: 0, countCol: 'cnt', sumCol: 'sum_eur' },
    rollup: { resultId: 'R2', row: 0, countCol: 'cnt', sumCol: 'sum_eur' },
  };

  it('confirms a matching aggregate against the rollup', async () => {
    const out = await runTool(
      'reconcile_rollup',
      { target: 'sector_totals', ...refs },
      withResults(),
    );
    expect(out).toBe('Съгласувано.');
  });

  it('surfaces the reconcile error message on a count mismatch', async () => {
    const out = await runTool(
      'reconcile_rollup',
      { target: 'company_totals', ...refs },
      withResults([11, 1000], [10, 1000]),
    );
    expect(out).toMatch(/count mismatch/);
  });

  it('refuses to reconcile against a home_totals target', async () => {
    const out = await runTool(
      'reconcile_rollup',
      { target: 'home_totals', ...refs },
      withResults(),
    );
    expect(out).toMatch(/^Заявката е отхвърлена/);
    expect(out).toContain('home_totals');
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

  it('leaves the report unchanged when no default filters were applied (Unit 4)', () => {
    const c = ctx();
    c.results.push({ handle: 'R1', columns: ['total_eur'], rows: [[1]] });
    const out = finalizeReport(
      { title: 't', question: 'q', blocks: [{ type: 'text', md: 'ок' }] },
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.blocks).toHaveLength(1);
      expect(out.report.blocks[0]).toEqual({ type: 'text', md: 'ок' });
    }
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
