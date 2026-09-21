// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';

import { ComboTrendChart, periodLabel } from './ComboTrendChart';

describe('periodLabel', () => {
  it('formats a month period', () => {
    expect(periodLabel('2024-03', 'month')).toBe('март 2024');
  });

  it('formats a quarter period', () => {
    expect(periodLabel('2024-Q1', 'quarter')).toBe('Q1 2024');
  });

  it('formats a year period verbatim', () => {
    expect(periodLabel('2024', 'year')).toBe('2024');
  });
});

function point(period: string, valueEur: number, contracts: number, partial = false): TrendPoint {
  return { period, valueEur, contracts, partial };
}

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

  it('renders nothing with fewer than 2 points', () => {
    act(() => {
      root.render(<ComboTrendChart points={[point('2024-Q1', 100, 1)]} granularity="quarter" />);
    });
    expect(container.querySelector('.combo-chart')).toBeNull();
  });

  it('renders bars, the line and year ticks for 2+ points', () => {
    const points = [
      point('2024-Q1', 100, 1),
      point('2024-Q2', 200, 2),
      point('2024-Q3', 150, 1, true),
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="quarter" />);
    });
    expect(container.querySelectorAll('.combo-bar').length).toBe(3);
    expect(container.querySelector('.combo-line')).not.toBeNull();
    expect(container.querySelector('.combo-line-partial')).not.toBeNull();
    expect(container.querySelectorAll('.combo-xlab span').length).toBe(1);
  });

  it('shows a hover tooltip on mouse enter when interactive', () => {
    const points = [point('2024-Q1', 100, 1), point('2024-Q2', 200, 2)];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="quarter" />);
    });
    expect(container.querySelector('.combo-tip')).toBeNull();
    const firstBar = container.querySelectorAll('.combo-bar')[0]!;
    act(() => {
      firstBar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('.combo-tip')).not.toBeNull();
    act(() => {
      container
        .querySelector('.combo-chart')!
        .dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('.combo-tip')).toBeNull();
  });

  it('does not attach hover handlers when interactive is false', () => {
    const points = [point('2024-Q1', 100, 1), point('2024-Q2', 200, 2)];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="quarter" interactive={false} />);
    });
    const firstBar = container.querySelectorAll('.combo-bar')[0]!;
    act(() => {
      firstBar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('.combo-tip')).toBeNull();
  });
});
