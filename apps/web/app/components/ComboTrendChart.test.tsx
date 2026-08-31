// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { ComboTrendChart } from './ComboTrendChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const W = 1000;

function points(n: number): TrendPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    period: `2024-${String(i + 1).padStart(2, '0')}`,
    valueEur: 1000 * (i + 1),
    contracts: 10 * (i + 1),
    partial: false,
  }));
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

  it.each([2, 3, 12])('keeps every bar inside the viewBox for n=%s points', (n) => {
    act(() => {
      root.render(<ComboTrendChart points={points(n)} granularity="month" />);
    });
    const bars = container.querySelectorAll('rect.combo-bar');
    expect(bars).toHaveLength(n);
    bars.forEach((bar) => {
      const x = Number(bar.getAttribute('x'));
      const width = Number(bar.getAttribute('width'));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(W + 0.05); // .toFixed(1) rounding slack
    });
  });
});
