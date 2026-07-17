import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReportBlockRenderer } from './ReportBlockRenderer';
import type { ResolvedBlock } from '~/lib/assistant/report-schema';

afterEach(() => {
  cleanup();
});

// Shared-surface regression: MarkdownBlock renders BOTH report text/callout blocks and dock prose.
// Extending it with lists/hr/tables must (a) newly structure report prose that uses those forms, and
// (b) leave plain report prose unchanged.
describe('ReportBlockRenderer — MarkdownBlock shared-surface', () => {
  const blocks = (...b: ResolvedBlock[]): ResolvedBlock[] => b;

  it('renders a list inside a report callout (intended additive change)', () => {
    const { container } = render(
      <ReportBlockRenderer
        blocks={blocks({ type: 'callout', title: 'Забележка', md: '- едно\n- две' })}
      />,
    );

    const items = container.querySelectorAll('.report-block--callout ul > li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('едно');
  });

  it('leaves a plain-prose text block unchanged (no regression)', () => {
    const { container } = render(
      <ReportBlockRenderer
        blocks={blocks({ type: 'text', md: 'Обикновен абзац без форматиране.' })}
      />,
    );

    const paras = container.querySelectorAll('.report-block--text p');
    expect(paras).toHaveLength(1);
    expect(paras[0].textContent).toBe('Обикновен абзац без форматиране.');
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });
});

// WCAG 1.1.1: every chart block must expose its data to assistive technology as a real
// <table>; the visual representation (CSS bars / SVG) must be hidden from AT.
describe('ReportBlockRenderer — chart blocks expose screen-reader data tables', () => {
  const barBlock = {
    type: 'bar' as const,
    points: [
      { label: 'София', value: 1200 },
      { label: null, value: 300 },
    ],
    format: 'number' as const,
  };

  it('bar: renders a hidden data table and hides the visual bar list from AT', () => {
    const { container } = render(<ReportBlockRenderer blocks={[barBlock]} />);

    const table = container.querySelector('.report-block--bar table.ts-data-table');
    expect(table).not.toBeNull();
    expect(table!.getAttribute('aria-label')).toBe('Данни от диаграмата');

    const headers = Array.from(table!.querySelectorAll('th[scope="col"]')).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['Категория', 'Стойност']);

    expect(container.querySelector('ul.report-bar')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('bar: table values match the visible bar values byte-for-byte and null labels render as —', () => {
    const { container } = render(<ReportBlockRenderer blocks={[barBlock]} />);

    const tableRows = Array.from(container.querySelectorAll('.ts-data-table tbody tr'));
    const listValues = Array.from(container.querySelectorAll('.report-bar__value')).map(
      (el) => el.textContent,
    );
    expect(tableRows).toHaveLength(2);
    expect(tableRows.map((tr) => tr.children[1].textContent)).toEqual(listValues);
    expect(tableRows[1].children[0].textContent).toBe('—');
  });

  it('flows: renders a real table with scoped column headers', () => {
    const { container } = render(
      <ReportBlockRenderer
        blocks={[
          {
            type: 'flows',
            edges: [{ from: 'МРРБ', to: 'Фирма X', valueEur: 5000 }],
          },
        ]}
      />,
    );

    const headers = container.querySelectorAll('.report-block--flows th[scope="col"]');
    expect(headers).toHaveLength(3);
    expect(container.querySelector('.report-block--flows tbody tr')).not.toBeNull();
  });

  it('timeseries: renders the hidden data table and an aria-hidden SVG', () => {
    const { container } = render(
      <ReportBlockRenderer
        blocks={[
          {
            type: 'timeseries',
            points: [
              { period: '2024-01', value: 10 },
              { period: '2024-02', value: 20 },
            ],
          },
        ]}
      />,
    );

    expect(container.querySelector('.report-block--timeseries table.ts-data-table')).not.toBeNull();
    expect(
      container.querySelector('.report-block--timeseries svg')!.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('every chart block type exposes its data values in a table', () => {
    const cases: { block: ResolvedBlock; expected: string }[] = [
      { block: barBlock, expected: 'София' },
      {
        block: { type: 'flows', edges: [{ from: 'МРРБ', to: 'Фирма X', valueEur: 5000 }] },
        expected: 'Фирма X',
      },
      {
        block: { type: 'timeseries', points: [{ period: '2024-03', value: 7 }] },
        expected: '2024-03',
      },
    ];
    for (const { block, expected } of cases) {
      const { container, unmount } = render(<ReportBlockRenderer blocks={[block]} />);
      const tables = Array.from(container.querySelectorAll('table'));
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.some((t) => t.textContent!.includes(expected))).toBe(true);
      unmount();
    }
  });
});
