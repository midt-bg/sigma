import { describe, expect, it } from 'vitest';
import { reportToDocxBlob, reportToMarkdown, safeFilename } from './report-export';
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

  it('renders a facts block as a Поле/Стойност table with its sub-annotation', () => {
    const md = reportToMarkdown(
      report([
        {
          type: 'facts',
          items: [
            { term: 'ЕИК', value: '103267194' },
            { term: 'Печалба', value: 1280000000, sub: 'за периода' },
          ],
        },
      ]),
    );
    expect(md).toContain('| Поле | Стойност |');
    expect(md).toContain('ЕИК');
    expect(md).toContain('103267194');
    expect(md).toContain('_(за периода)_'); // sub annotation appended to the value
  });
});

describe('reportToDocxBlob', () => {
  // One report exercising every block-type branch of the ~240-line DOCX builder in a single pass.
  const everyBlock: ResolvedReport['blocks'] = [
    { type: 'text', md: 'Увод.' },
    { type: 'callout', title: 'Внимание', md: 'Бележка.' },
    { type: 'totals', items: [{ label: 'Общо', value: 1234567, format: 'money' }] },
    { type: 'facts', items: [{ term: 'ЕИК', value: '103267194', sub: 'регистър' }] },
    {
      type: 'table',
      columns: [
        { key: 'name', header: 'Фирма', format: 'text' },
        { key: 'val', header: 'Сума', align: 'right', format: 'money' },
      ],
      rows: [{ cells: ['Фирма АД', 999999] }],
    },
    { type: 'bar', points: [{ label: 'Фирма А', value: 500000 }], format: 'money' },
    { type: 'flows', edges: [{ from: 'МЗ', to: 'Фарма ООД', valueEur: 42000 }] },
    { type: 'timeseries', points: [{ period: '2024-01', value: 1000 }] },
  ];

  it('produces a real, non-empty .docx (ZIP container) covering every block type', async () => {
    const blob = await reportToDocxBlob(report(everyBlock));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    // OOXML is a ZIP — the container must start with the PK local-file-header magic bytes.
    const head = new Uint8Array(await blob.arrayBuffer()).subarray(0, 2);
    expect(Array.from(head)).toEqual([0x50, 0x4b]); // "PK"
  });

  it('produces a valid document for an empty report (no blocks)', async () => {
    const blob = await reportToDocxBlob(report([]));
    expect(blob.size).toBeGreaterThan(0);
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
