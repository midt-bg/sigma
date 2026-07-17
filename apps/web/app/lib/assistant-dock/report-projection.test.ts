import { describe, expect, it, vi } from 'vitest';
import reportFixture from './__fixtures__/report.fixture.json';
import type { CellFormat, ResolvedReport } from './contract';
import {
  dedupHitFromMessage,
  isToolTurnWithoutReport,
  projectChip,
  reportOutputFromMessage,
} from './report-projection';
import { DEDUP_PART } from '../../../workers/assistant/dedup-stream';

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

  it('returns the last output on a retry turn: the {ok:true} retry wins over the earlier {ok:false}', () => {
    const success = { ok: true, report: totalsReport(1, 'money') };
    const message = {
      parts: [
        {
          type: 'tool-emit_report',
          state: 'output-available',
          output: { ok: false, errors: ['x'] },
        },
        { type: 'tool-emit_report', state: 'output-available', output: success },
      ],
    };

    expect(reportOutputFromMessage(message)).toBe(success);
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

describe('isToolTurnWithoutReport', () => {
  it('is true when a run_sql call happened but no report part exists (out-of-steps turn)', () => {
    expect(
      isToolTurnWithoutReport({
        parts: [{ type: 'tool-run_sql', state: 'output-available', output: 'R1 …' }],
      }),
    ).toBe(true);
  });

  it('is false once an emit_report part exists (any state)', () => {
    expect(
      isToolTurnWithoutReport({
        parts: [
          { type: 'tool-run_sql', state: 'output-available' },
          {
            type: 'tool-emit_report',
            state: 'output-available',
            output: { ok: false, errors: [] },
          },
        ],
      }),
    ).toBe(false);
  });

  it('is false for a prose-only message (no tool calls at all)', () => {
    expect(isToolTurnWithoutReport({ parts: [{ type: 'text' }] })).toBe(false);
  });
});

describe('dedupHitFromMessage', () => {
  const hit = {
    reportId: 'r_abc',
    createdAt: '2026-07-06T00:00:00Z',
    layer: 'L1',
    label: 'Преизползване на съществуващ отчет',
  };

  it('returns the dedup data from a cache-hit message', () => {
    expect(dedupHitFromMessage({ parts: [{ type: DEDUP_PART, data: hit }] })).toEqual(hit);
  });

  it('returns null for a message with no dedup part', () => {
    expect(dedupHitFromMessage({ parts: [{ type: 'text' }] })).toBeNull();
  });

  it('returns null when the dedup data is malformed (missing reportId)', () => {
    expect(dedupHitFromMessage({ parts: [{ type: DEDUP_PART, data: { label: 'x' } }] })).toBeNull();
  });

  it('ignores a dedup part carrying no data at all', () => {
    expect(dedupHitFromMessage({ parts: [{ type: DEDUP_PART }] })).toBeNull();
  });

  it('rejects a dedup part whose layer is outside the known set (localStorage tamper)', () => {
    const tampered = { ...hit, layer: 'L9' };
    expect(dedupHitFromMessage({ parts: [{ type: DEDUP_PART, data: tampered }] })).toBeNull();
  });

  it('accepts a fractional layer label that is valid (L2.5)', () => {
    const l25 = { ...hit, layer: 'L2.5' };
    expect(dedupHitFromMessage({ parts: [{ type: DEDUP_PART, data: l25 }] })).toEqual(l25);
  });
});
