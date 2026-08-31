// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';

import { ComboTrendChart } from './ComboTrendChart';

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

  // Regression: the partial-is-always-last invariant can be violated upstream. When the
  // partial period lands at index 0 instead of last, `hasPartial` must still detect it —
  // `partialIdx > 0` treats index 0 as "no partial period" and silently renders the whole
  // series as solid.
  it('detects a partial period at index 0 and renders the dashed-partial path', () => {
    const points: TrendPoint[] = [
      { period: '2024-01', valueEur: 5, contracts: 1, partial: true },
      { period: '2024-02', valueEur: 10, contracts: 2, partial: false },
      { period: '2024-03', valueEur: 20, contracts: 3, partial: false },
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="month" />);
    });
    // Not just present — it must carry a real, drawable `d` (a "MoveTo ... LineTo ..." pair),
    // not the empty `d=""` that solidEnd === -1 used to produce for a partial at index 0.
    const d = comboLinePartial()?.getAttribute('d');
    expect(d).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  });

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

  // Regression: the partial-is-always-last invariant can be violated upstream (index 2 of 5).
  // Points after the partial marker are still complete data — the chart must keep drawing them
  // as a second solid segment instead of silently truncating the line there.
  it('keeps drawing the points after a mid-series partial period instead of dropping them', () => {
    const points: TrendPoint[] = [
      { period: '2024-01', valueEur: 5, contracts: 1, partial: false },
      { period: '2024-02', valueEur: 10, contracts: 2, partial: false },
      { period: '2024-03', valueEur: 20, contracts: 3, partial: true },
      { period: '2024-04', valueEur: 15, contracts: 2, partial: false },
      { period: '2024-05', valueEur: 25, contracts: 4, partial: false },
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="month" />);
    });
    const solidPaths = container.querySelectorAll('path.combo-line');
    // One solid segment up to the partial point, one for the points after it.
    expect(solidPaths.length).toBe(2);
    expect(solidPaths[1]?.getAttribute('d')).toMatch(
      /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/,
    );
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
});
