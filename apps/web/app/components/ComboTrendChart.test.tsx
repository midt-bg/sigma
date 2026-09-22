// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';

import { ComboTrendChart, periodLabel } from './ComboTrendChart';

describe('ComboTrendChart', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function comboLinePartial() {
    return container.querySelector('path.combo-line-partial');
  }

  it('detects a partial period at the last index (the normal case)', () => {
    const points: TrendPoint[] = [
      { period: '2024-01', valueEur: 5, contracts: 1, partial: false },
      { period: '2024-02', valueEur: 10, contracts: 2, partial: false },
      { period: '2024-03', valueEur: 20, contracts: 3, partial: true },
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="month" />);
    });
    expect(comboLinePartial()).not.toBeNull();
  });

  it('renders no dashed-partial path when nothing is partial', () => {
    const points: TrendPoint[] = [
      { period: '2024-01', valueEur: 5, contracts: 1, partial: false },
      { period: '2024-02', valueEur: 10, contracts: 2, partial: false },
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="month" />);
    });
    expect(comboLinePartial()).toBeNull();
  });

  const HOVER_POINTS: TrendPoint[] = [
    { period: '2024-01', valueEur: 5, contracts: 1, partial: false },
    { period: '2024-02', valueEur: 10, contracts: 2, partial: true },
  ];
  const hoverBar = (i: number, type: 'mouseover' | 'mouseout' = 'mouseover') =>
    act(() => {
      container
        .querySelectorAll('rect.combo-bar')
        [i]!.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }));
    });

  it('renders nothing when there are fewer than two points to draw a line between', () => {
    act(() => {
      root.render(<ComboTrendChart points={HOVER_POINTS.slice(0, 1)} granularity="month" />);
    });
    expect(container.innerHTML).toBe('');
  });

  it('shows a tooltip with the period, value and count when a bar is hovered, and clears on leave', () => {
    act(() => {
      root.render(<ComboTrendChart points={HOVER_POINTS} granularity="month" />);
    });
    expect(container.querySelector('.combo-tip')).toBeNull();
    hoverBar(0);
    const tip = container.querySelector('.combo-tip');
    expect(tip?.textContent).toContain('договори');
    // Complete period: no „частично" suffix, and the bar/cursor/dot follow the hover.
    expect(tip?.textContent).not.toContain('частично');
    expect(container.querySelectorAll('rect.combo-bar')[0]!.getAttribute('class')).toContain(
      'is-hover',
    );
    expect(container.querySelector('.combo-cursor')).not.toBeNull();
    expect(container.querySelector('.combo-dot')).not.toBeNull();

    // The still-filling final period is labelled as such.
    hoverBar(1);
    expect(container.querySelector('.combo-tip')?.textContent).toContain('частично');

    act(() => {
      container
        .querySelector('.combo-chart')!
        .dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.querySelector('.combo-tip')).toBeNull();
  });

  it('ignores hover entirely on a non-interactive chart', () => {
    act(() => {
      root.render(
        <ComboTrendChart points={HOVER_POINTS} granularity="month" interactive={false} />,
      );
    });
    hoverBar(0);
    expect(container.querySelector('.combo-tip')).toBeNull();
    expect(container.querySelector('.combo-cursor')).toBeNull();
  });

  it('uses the caller-supplied accessible label on the chart', () => {
    act(() => {
      root.render(
        <ComboTrendChart
          points={HOVER_POINTS}
          granularity="month"
          ariaLabel="Само избрани групи"
        />,
      );
    });
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Само избрани групи');
  });
});

describe('periodLabel', () => {
  it('formats a year, a quarter and a month period for their granularity', () => {
    expect(periodLabel('2024', 'year')).toBe('2024');
    expect(periodLabel('2024-Q3', 'quarter')).toBe('Q3 2024');
    expect(periodLabel('2024-03', 'month')).toContain('2024');
    expect(periodLabel('2024-03', 'month')).not.toBe('2024-03');
  });
});

describe('ComboTrendChart x-axis year labels', () => {
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
  const labels = () =>
    Array.from(container.querySelectorAll('.combo-xlab span')).map((e) => e.textContent);

  it('labels every point at year grain', () => {
    const points: TrendPoint[] = ['2022', '2023', '2024'].map((period) => ({
      period,
      valueEur: 1,
      contracts: 1,
      partial: false,
    }));
    act(() => root.render(<ComboTrendChart points={points} granularity="year" />));
    expect(labels()).toEqual(['2022', '2023', '2024']);
  });

  it('labels only the first quarter of each year at quarter grain', () => {
    const points: TrendPoint[] = ['2023-Q3', '2023-Q4', '2024-Q1', '2024-Q2'].map((period) => ({
      period,
      valueEur: 1,
      contracts: 1,
      partial: false,
    }));
    act(() => root.render(<ComboTrendChart points={points} granularity="quarter" />));
    expect(labels()).toEqual(['2024']);
  });
});
