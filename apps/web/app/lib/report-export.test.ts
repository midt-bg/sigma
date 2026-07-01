import { describe, expect, it } from 'vitest';
import { reportToMarkdown, safeFilename } from './report-export';
import type { ResolvedReport } from '~/lib/assistant-contract/report';

function report(blocks: ResolvedReport['blocks']): ResolvedReport {
  return { title: 'Test', question: 'Въпрос?', blocks, watermark: 'ai-generated' };
}

describe('reportToMarkdown', () => {
  it('opens with the title and question', () => {
    const md = reportToMarkdown(report([]));
    expect(md).toMatch(/^# Test\n/);
    expect(md).toContain('_Въпрос?_');
  });

  it('closes with the AI-unofficial watermark', () => {
    const md = reportToMarkdown(report([]));
    expect(md).toContain('---');
    expect(md).toContain('AI-генерирано, неофициално');
  });

  it('renders a text block', () => {
    const md = reportToMarkdown(report([{ type: 'text', md: 'Проста бележка.' }]));
    expect(md).toContain('Проста бележка.');
  });

  it('renders a callout block as a blockquote', () => {
    const md = reportToMarkdown(report([{ type: 'callout', title: 'Внимание', md: 'Текст тук.' }]));
    expect(md).toContain('> **Внимание**');
    expect(md).toContain('> Текст тук.');
  });

  it('renders totals as a markdown table', () => {
    const md = reportToMarkdown(
      report([{ type: 'totals', items: [{ label: 'Общо', value: 1234567, format: 'money' }] }]),
    );
    expect(md).toContain('| Показател | Стойност |');
    expect(md).toContain('Общо');
  });

  it('renders bar points as numbered list with formatted values', () => {
    const md = reportToMarkdown(
      report([
        {
          type: 'bar',
          points: [
            { label: 'Фирма А', value: 500000 },
            { label: 'Фирма Б', value: 200000 },
          ],
          format: 'money',
        },
      ]),
    );
    expect(md).toContain('1. Фирма А');
    expect(md).toContain('2. Фирма Б');
  });

  it('renders bar with non-money format', () => {
    const md = reportToMarkdown(
      report([{ type: 'bar', points: [{ label: 'X', value: 42 }], format: 'number' }]),
    );
    expect(md).toContain('1. X');
    // Should not be money-formatted (no '€') for number format
    const barLine = md.split('\n').find((l) => l.startsWith('1.'));
    expect(barLine).toBeDefined();
    expect(barLine).not.toContain('€');
  });

  it('renders timeseries as a markdown table', () => {
    const md = reportToMarkdown(
      report([
        {
          type: 'timeseries',
          points: [
            { period: '2024-01', value: 1000 },
            { period: '2024-02', value: 2000 },
          ],
        },
      ]),
    );
    expect(md).toContain('| Период | Стойност |');
    expect(md).toContain('2024-01');
    expect(md).toContain('2024-02');
  });

  it('renders table block with column headers', () => {
    const md = reportToMarkdown(
      report([
        {
          type: 'table',
          columns: [
            { key: 'name', header: 'Фирма', format: 'text' },
            { key: 'val', header: 'Сума', format: 'money' },
          ],
          rows: [{ cells: ['Фирма АД', 999999] }],
        },
      ]),
    );
    expect(md).toContain('| Фирма | Сума |');
    expect(md).toContain('Фирма АД');
  });

  it('escapes pipe characters in table cells', () => {
    const md = reportToMarkdown(
      report([{ type: 'totals', items: [{ label: 'A|B', value: '1', format: 'text' }] }]),
    );
    expect(md).toContain('A\\|B');
  });
});

describe('safeFilename', () => {
  it('produces a valid filename with extension', () => {
    expect(safeFilename('My Report', 'md')).toBe('My-Report.md');
  });

  it('strips non-alphanumeric characters', () => {
    expect(safeFilename('Топ 10!!! фирми', 'md')).toMatch(/\.md$/);
  });

  it('caps at 50 characters before the extension', () => {
    const long = 'A'.repeat(60);
    const name = safeFilename(long, 'md');
    expect(name.replace(/\.md$/, '').length).toBeLessThanOrEqual(50);
  });
});
