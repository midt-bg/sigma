// @vitest-environment jsdom
// The spend-over-time chart is a static SVG. Two things are load-bearing: the still-filling final period must
// not read as a real decline — it is drawn as a dashed, labelled tail off the solid line — and the year axis
// names each year once. The coordinates below follow the full-size frame: 760 wide, 240 high, the line
// between y = 28 (the maximum) and y = 218 (zero).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { TrendChart } from './TrendChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
  return container;
}

const point = (period: string, valueEur: number, partial = false): TrendPoint => ({
  period,
  valueEur,
  contracts: 1,
  partial,
});

describe('TrendChart', () => {
  it('draws nothing for fewer than two points', () => {
    expect(render(<TrendChart points={[]} granularity="year" />).querySelector('svg')).toBeNull();
    expect(
      render(<TrendChart points={[point('2024', 5)]} granularity="year" />).querySelector('svg'),
    ).toBeNull();
  });

  it('draws the full-size frame unless asked for the compact one', () => {
    const points = [point('2023', 1), point('2024', 2)];
    const viewBox = (el: React.ReactElement) =>
      render(el).querySelector('svg')!.getAttribute('viewBox');
    expect(viewBox(<TrendChart points={points} granularity="year" />)).toBe('-14 0 788 240');
    expect(viewBox(<TrendChart points={points} granularity="year" compact />)).toBe(
      '-14 0 488 180',
    );
  });

  it('draws a still-filling final period as a dashed, labelled tail off the solid line', () => {
    const c = render(
      <TrendChart
        points={[point('2022', 100), point('2023', 100), point('2024', 10, true)]}
        granularity="year"
      />,
    );
    // The solid line and its area stop at the last complete year…
    expect(c.querySelector('path.line')!.getAttribute('d')).toBe('M0.0,28.0L380.0,28.0');
    expect(c.querySelector('path.area')!.getAttribute('d')).toBe(
      'M0.0,28.0L380.0,28.0L380.0,218L0,218Z',
    );
    // …and only the dashed tail reaches down to the partial one, which is marked and named.
    expect(c.querySelector('path.line-partial')!.getAttribute('d')).toBe('M380.0,28.0L760.0,199.0');
    const dot = c.querySelector('circle.dot-partial')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['760', '199']);
    expect(c.querySelector('text.label-partial')!.textContent).toBe('частично');
  });

  it('keeps a complete series solid to its last point', () => {
    const c = render(
      <TrendChart points={[point('2023', 100), point('2024', 50)]} granularity="year" />,
    );
    expect(c.querySelector('path.line')!.getAttribute('d')).toBe('M0.0,28.0L760.0,123.0');
    expect(c.querySelector('.line-partial, .dot-partial, .label-partial')).toBeNull();
  });

  it('names each year once, at its January, on a monthly series', () => {
    const months = ['2023-11', '2023-12', '2024-01', '2024-02', '2025-01'].map((m) => point(m, 10));
    const c = render(<TrendChart points={months} granularity="month" />);
    expect([...c.querySelectorAll('text.label')].map((t) => t.textContent)).toEqual([
      '2024',
      '2025',
    ]);
    expect(c.querySelectorAll('line.grid')).toHaveLength(2);
  });
});
