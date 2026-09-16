// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint, TrendYear } from '@sigma/api-contract';
import { TrendBlock } from './TrendBlock';

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

const point = (period: string, valueEur: number): TrendPoint => ({
  period,
  valueEur,
  contracts: 1,
  partial: false,
});
const year = (y: string, valueEur: number): TrendYear => ({
  year: y,
  valueEur,
  contracts: 1,
  yoyPct: null,
  partial: false,
});

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
  return container;
}

describe('TrendBlock', () => {
  it('says so when there is nothing dated, rather than rendering an empty table', () => {
    const c = render(
      <TrendBlock points={[]} years={[]} granularity="year" caption="Разходи по години" />,
    );
    expect(c.querySelector('table')).toBeNull();
    expect(c.textContent).toContain('Няма договори с валидна дата');
  });

  it('shows a single year as a number in the table, not as a one-point chart', () => {
    const c = render(
      <TrendBlock
        points={[point('2023', 100)]}
        years={[year('2023', 100)]}
        granularity="year"
        caption="Разходи по години"
      />,
    );
    expect(c.querySelector('svg')).toBeNull();
    expect(c.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('draws the chart next to the table when asked to split, and above it otherwise', () => {
    const props = {
      points: [point('2022', 50), point('2023', 100)],
      years: [year('2022', 50), year('2023', 100)],
      granularity: 'year' as const,
      caption: 'Разходи по години',
    };
    const side = render(<TrendBlock {...props} split />);
    expect(side.querySelector('.trend-split svg')).not.toBeNull();
    expect(side.querySelector('.trend-split table')).not.toBeNull();
    const stacked = render(<TrendBlock {...props} />);
    expect(stacked.querySelector('.trend-split')).toBeNull();
    expect(stacked.querySelector('.mt-8 table')).not.toBeNull();
  });
});
