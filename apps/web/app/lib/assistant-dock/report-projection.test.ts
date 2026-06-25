import { describe, expect, it, vi } from 'vitest';
import type { ReportArtifact } from './contract';
import { leadStat, reportViewFromMessage } from './report-projection';

// Mock the site formatters so we assert WHICH formatter is applied to WHICH value — not @sigma/shared's
// own output (that has its own tests). Each returns an identifiable string.
vi.mock('@sigma/shared', () => ({
  money: (v: unknown) => `money:${v}`,
  count: (v: unknown) => `count:${v}`,
  pct: (v: unknown) => `pct:${v}`,
  date: (v: unknown) => `date:${v}`,
}));

const artifact = (blocks: ReportArtifact['blocks']): ReportArtifact => ({ title: 'Тест', blocks });

describe('leadStat', () => {
  it('formats a money lead stat from the first totals item', () => {
    const report = artifact([
      { type: 'totals', items: [{ label: 'Похарчено', value: 2604567, format: 'money' }] },
    ]);

    expect(leadStat(report)).toBe('Похарчено: money:2604567');
  });

  it('formats a number lead stat', () => {
    const report = artifact([
      { type: 'totals', items: [{ label: 'Брой', value: 3, format: 'number' }] },
    ]);

    expect(leadStat(report)).toBe('Брой: count:3');
  });

  it('formats a percent lead stat', () => {
    const report = artifact([
      { type: 'totals', items: [{ label: 'Дял', value: 0.42, format: 'percent' }] },
    ]);

    expect(leadStat(report)).toBe('Дял: pct:0.42');
  });

  it('formats a date lead stat', () => {
    const report = artifact([
      { type: 'totals', items: [{ label: 'Дата', value: '2026-06-18', format: 'date' }] },
    ]);

    expect(leadStat(report)).toBe('Дата: date:2026-06-18');
  });

  it('defaults the totals format to text when absent', () => {
    const report = artifact([{ type: 'totals', items: [{ label: 'Бележка', value: 'превю' }] }]);

    expect(leadStat(report)).toBe('Бележка: превю');
  });

  it('falls back to the first facts row when there are no totals', () => {
    const report = artifact([{ type: 'facts', rows: [{ term: 'Компания', value: 'Алфа ООД' }] }]);

    expect(leadStat(report)).toBe('Компания: Алфа ООД');
  });

  it('has no lead stat for a report without totals or facts', () => {
    expect(leadStat(artifact([{ type: 'text', content: 'само текст' }]))).toBeNull();
  });

  it('shows an em-dash for a facts value that is not a primitive', () => {
    const report = artifact([
      { type: 'facts', rows: [{ term: 'Поле', value: {} as unknown as string }] },
    ]);

    expect(leadStat(report)).toBe('Поле: —');
  });
});

describe('reportViewFromMessage', () => {
  const emitPart = (state: string, extra: Record<string, unknown>) => ({
    parts: [{ type: 'tool-emit_report', state, ...extra }],
  });

  it('projects a finished report to a chip (title and href from the result)', () => {
    const view = reportViewFromMessage(
      emitPart('output-available', {
        input: artifact([
          { type: 'totals', items: [{ label: 'Похарчено', value: 100, format: 'money' }] },
        ]),
        output: { id: 'r_abc', title: 'Заглавие', url: '/reports/r_abc' },
      }),
    );

    expect(view.chip).toEqual({
      title: 'Заглавие',
      href: '/reports/r_abc',
      leadStat: 'Похарчено: money:100',
    });
  });

  it('falls back to /reports/:id when the result url is empty', () => {
    const view = reportViewFromMessage(
      emitPart('output-available', {
        input: artifact([]),
        output: { id: 'r_x', title: 'T', url: '' },
      }),
    );

    expect(view.chip?.href).toBe('/reports/r_x');
  });

  it('surfaces an emit_report error result', () => {
    const view = reportViewFromMessage(
      emitPart('output-available', { output: { error: 'Справката е твърде голяма.' } }),
    );

    expect(view.error).toBe('Справката е твърде голяма.');
  });

  it('returns no chip for a malformed result (missing id)', () => {
    const view = reportViewFromMessage(
      emitPart('output-available', { output: { title: 'no id' } }),
    );

    expect(view.chip).toBeNull();
  });

  it('labels the in-flight report tool', () => {
    expect(reportViewFromMessage(emitPart('input-available', {})).pendingLabel).toBe(
      'Подготвям справка…',
    );
  });

  it('labels another in-flight tool by name', () => {
    const view = reportViewFromMessage({
      parts: [{ type: 'tool-run_sql', state: 'input-streaming' }],
    });

    expect(view.pendingLabel).toBe('Изпълнява заявка…');
  });

  it('is empty for a prose-only message', () => {
    expect(reportViewFromMessage({ parts: [{ type: 'text' }] })).toEqual({
      chip: null,
      error: null,
      pendingLabel: null,
    });
  });
});
