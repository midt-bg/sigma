// @vitest-environment jsdom
// The spend-over-time chart is a static SVG. Two things are load-bearing: the still-filling final period must
// not read as a real decline — it is drawn as a dashed, labelled tail off the solid line — and the year axis
// names each year once. The coordinates below follow the full-size frame: 760 wide, 240 high, the line
// between y = 28 (the maximum) and y = 234 (zero).
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
      'M0.0,28.0L380.0,28.0L380.0,234L0,234Z',
    );
    // …and only the dashed tail reaches down to the partial one, which is marked and named.
    expect(c.querySelector('path.line-partial')!.getAttribute('d')).toBe('M380.0,28.0L760.0,213.4');
    const dot = c.querySelector('circle.dot-partial')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['760', '213.4']);
    expect(c.querySelector('.label-partial')!.textContent).toBe('частично');
  });

  it('draws a partial first year as a dashed, labelled head into the solid line', () => {
    const first = { ...point('2022', 10), partialStart: true };
    const c = render(
      <TrendChart points={[first, point('2023', 100), point('2024', 100)]} granularity="year" />,
    );
    // The solid line and its area start at the first complete year…
    expect(c.querySelector('path.line')!.getAttribute('d')).toBe('M380.0,28.0L760.0,28.0');
    expect(c.querySelector('path.area')!.getAttribute('d')).toBe(
      'M380.0,28.0L760.0,28.0L760.0,234L380.0,234Z',
    );
    // …and the partial first year joins it dashed, marked and named.
    expect(c.querySelector('path.line-partial')!.getAttribute('d')).toBe('M0.0,213.4L380.0,28.0');
    const dot = c.querySelector('circle.dot-partial')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['0', '213.4']);
    expect(c.querySelector('.label-partial')!.textContent).toBe('частично');
  });

  it('draws two points that are both partial without a solid line', () => {
    const first = { ...point('2025', 10), partialStart: true };
    const c = render(<TrendChart points={[first, point('2026', 5, true)]} granularity="year" />);
    expect(c.querySelector('path.line')).toBeNull();
    expect(c.querySelector('path.area')).toBeNull();
    expect(c.querySelectorAll('path.line-partial')).toHaveLength(2);
  });

  it('keeps a complete series solid to its last point', () => {
    const c = render(
      <TrendChart points={[point('2023', 100), point('2024', 50)]} granularity="year" />,
    );
    expect(c.querySelector('path.line')!.getAttribute('d')).toBe('M0.0,28.0L760.0,131.0');
    expect(c.querySelector('.line-partial, .dot-partial, .label-partial')).toBeNull();
  });

  it('names each year once, at its January, on a monthly series', () => {
    const months = ['2023-11', '2023-12', '2024-01', '2024-02', '2025-01'].map((m) => point(m, 10));
    const c = render(<TrendChart points={months} granularity="month" />);
    expect([...c.querySelectorAll('.trend-axis .label')].map((t) => t.textContent)).toEqual([
      '2024',
      '2025',
    ]);
    expect(c.querySelectorAll('line.grid')).toHaveLength(2);
  });

  // SVG text shrinks with the drawing (4–7 px on a phone) and ignores zoom and the default font size,
  // so the words are HTML placed in percent of the drawing's -14…774 wide box.
  it('writes the year axis and the notes as HTML, not as SVG text', () => {
    const c = render(
      <TrendChart
        points={[point('2022', 100), point('2023', 100), point('2024', 10, true)]}
        granularity="year"
      />,
    );
    expect(c.querySelector('svg text')).toBeNull();
    const labels = [...c.querySelectorAll<HTMLElement>('.trend-axis .label')];
    expect(labels.map((l) => [l.textContent, l.style.left])).toEqual([
      ['2022', '1.78%'],
      ['2023', '50%'],
      ['2024', '98.22%'],
    ]);
    const note = c.querySelector<HTMLElement>('.label-partial')!;
    expect([note.style.left, note.style.top]).toEqual(['98.22%', '88.92%']);
    expect(c.querySelector('.trend-axis')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('names the peak month of a monthly series in words, and only of a monthly one', () => {
    const months = [point('2024-11', 10), point('2024-12', 2_500_000), point('2025-01', 30)];
    const c = render(<TrendChart points={months} granularity="month" />);
    const peak = 'Най-висок месец: декември 2024 — 2,5\u00a0млн.\u00a0€';
    expect(c.querySelector('figcaption')!.textContent).toBe(peak);
    expect(c.querySelector('svg')!.getAttribute('aria-label')).toContain(peak);
    const years = render(
      <TrendChart points={[point('2023', 1), point('2024', 2)]} granularity="year" />,
    );
    expect(years.querySelector('figcaption')).toBeNull();
  });
});
