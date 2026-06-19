import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, finalizeReport, runTool, type ToolContext } from './tools';

function ctx(rows: Record<string, string | number | null>[] = []): ToolContext {
  const db = {
    prepare(_sql: string) {
      return {
        bind() {
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
  return { db, results: [] };
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
});

describe('semantic_search', () => {
  it('degrades gracefully when the AI/Vectorize bindings are absent', async () => {
    expect(await runTool('semantic_search', { query: 'детски градини' }, ctx())).toMatch(
      /не е налично/,
    );
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
