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

  // The dashed segment for a partial at index 0 already covers point0 → point1, so the solid tail
  // must start at point1 — starting it at point0 would overdraw the dashed segment in solid.
  it('does not overdraw the dashed segment with a solid one when the partial is at index 0', () => {
    const points: TrendPoint[] = [
      { period: '2024-01', valueEur: 5, contracts: 1, partial: true },
      { period: '2024-02', valueEur: 10, contracts: 2, partial: false },
      { period: '2024-03', valueEur: 20, contracts: 3, partial: false },
    ];
    act(() => {
      root.render(<ComboTrendChart points={points} granularity="month" />);
    });
    const dashed = comboLinePartial()!.getAttribute('d')!;
    const solid = Array.from(container.querySelectorAll('path.combo-line')).map((el) =>
      el.getAttribute('d'),
    );
    // solid[0] is the (empty-anchored) main line; the tail is the extra path when present.
    const tail = solid[solid.length - 1]!;
    const dashedStart = dashed.split(' L')[0]!;
    expect(tail.startsWith(dashedStart)).toBe(false);
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
