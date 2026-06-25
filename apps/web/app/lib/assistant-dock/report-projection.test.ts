import { describe, expect, it, vi } from 'vitest';
import reportFixture from './__fixtures__/report.fixture.json';
import type { CellFormat, ResolvedReport } from './contract';
import { isReportPending, projectChip, reportOutputFromMessage } from './report-projection';

// Mock the site formatters so we assert WHICH formatter is applied to WHICH value — not @sigma/shared's
// own output (that has its own tests). Each returns an identifiable string.
vi.mock('@sigma/shared', () => ({
  money: (v: unknown) => `money:${v}`,
  count: (v: unknown) => `count:${v}`,
  pct: (v: unknown) => `pct:${v}`,
  date: (v: unknown) => `date:${v}`,
}));

const totalsReport = (value: string | number | null, format: CellFormat): ResolvedReport => ({
  title: 'Тест',
  question: 'q',
  watermark: 'ai-generated',
  blocks: [{ type: 'totals', items: [{ label: 'Етикет', value, format }] }],
});

describe('reportOutputFromMessage', () => {
  it('returns the output of a settled emit_report part', () => {
    const output = { ok: true, report: totalsReport(1, 'money') };
    const message = {
      parts: [{ type: 'text' }, { type: 'tool-emit_report', state: 'output-available', output }],
    };

    expect(reportOutputFromMessage(message)).toBe(output);
  });

  it('returns the failed output so the caller can fall back to prose', () => {
    const output = { ok: false, errors: ['не успях'] };
    const message = { parts: [{ type: 'tool-emit_report', state: 'output-available', output }] };

    expect(reportOutputFromMessage(message)).toEqual({ ok: false, errors: ['не успях'] });
  });

  it('returns null while the report tool is still running', () => {
    const message = { parts: [{ type: 'tool-emit_report', state: 'input-available' }] };

    expect(reportOutputFromMessage(message)).toBeNull();
  });

  it('returns null for a prose-only message', () => {
    expect(reportOutputFromMessage({ parts: [{ type: 'text' }] })).toBeNull();
  });

  it('returns null when a settled output is malformed (missing ok)', () => {
    const message = {
      parts: [{ type: 'tool-emit_report', state: 'output-available', output: { report: {} } }],
    };

    expect(reportOutputFromMessage(message)).toBeNull();
  });
});

describe('projectChip', () => {
  it('uses the report title', () => {
    expect(projectChip(totalsReport(1000, 'money')).title).toBe('Тест');
  });

  it('formats a money lead stat from the first totals item', () => {
    expect(projectChip(totalsReport(2604567, 'money')).leadStat).toBe('Етикет: money:2604567');
  });

  it('formats a number lead stat', () => {
    expect(projectChip(totalsReport(3, 'number')).leadStat).toBe('Етикет: count:3');
  });

  it('formats a percent lead stat', () => {
    expect(projectChip(totalsReport(0.42, 'percent')).leadStat).toBe('Етикет: pct:0.42');
  });

  it('formats a date lead stat', () => {
    expect(projectChip(totalsReport('2026-06-18', 'date')).leadStat).toBe(
      'Етикет: date:2026-06-18',
    );
  });

  it('falls back to the first facts item when there are no totals', () => {
    const report: ResolvedReport = {
      title: 'Тест',
      question: 'q',
      watermark: 'ai-generated',
      blocks: [{ type: 'facts', items: [{ term: 'Компания', value: 'Алфа ООД' }] }],
    };

    expect(projectChip(report).leadStat).toBe('Компания: Алфа ООД');
  });

  it('shows an em-dash for a facts value that is not a primitive', () => {
    const report: ResolvedReport = {
      title: 'Тест',
      question: 'q',
      watermark: 'ai-generated',
      blocks: [{ type: 'facts', items: [{ term: 'Поле', value: {} as unknown as string }] }],
    };

    expect(projectChip(report).leadStat).toBe('Поле: —');
  });

  it('has no lead stat for a report without totals or facts', () => {
    const report: ResolvedReport = {
      title: 'Тест',
      question: 'q',
      watermark: 'ai-generated',
      blocks: [{ type: 'text', md: 'само текст' }],
    };

    expect(projectChip(report).leadStat).toBeNull();
  });

  it('projects the vendored fixture report title', () => {
    const report = reportFixture as unknown as ResolvedReport;

    expect(projectChip(report).title).toBe('Най-големи възложители по похарчено');
  });

  it('projects the vendored fixture report lead stat', () => {
    const report = reportFixture as unknown as ResolvedReport;

    expect(projectChip(report).leadStat).toBe('Похарчено (топ 3): money:2604567');
  });
});

describe('isReportPending', () => {
  it('is pending while the report tool is still running', () => {
    expect(
      isReportPending({ parts: [{ type: 'tool-emit_report', state: 'input-available' }] }),
    ).toBe(true);
  });

  it('is not pending once the report output is available', () => {
    expect(
      isReportPending({
        parts: [{ type: 'tool-emit_report', state: 'output-available', output: {} }],
      }),
    ).toBe(false);
  });

  it('is not pending for a prose-only message', () => {
    expect(isReportPending({ parts: [{ type: 'text' }] })).toBe(false);
  });
});
