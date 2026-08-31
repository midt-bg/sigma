import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLICK_DISTANCE,
  initialReducedMotion,
  isDragGesture,
  linkHop,
  subscribeReducedMotion,
} from './useForceGraph';

const node = (hop: number) => ({ id: `n${hop}`, hop, r: 10 });

// Minimal fake MediaQueryList — just enough to drive addEventListener/removeEventListener/dispatch,
// without a full jsdom/matchMedia environment.
function fakeMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    get matches() {
      return matches;
    },
    addEventListener: (_type: 'change', cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: 'change', cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    },
  };
  const fire = (next: boolean) => {
    matches = next;
    for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
  };
  return { mq, fire, listenerCount: () => listeners.size };
}

describe('initialReducedMotion / subscribeReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the current preference once at call time', () => {
    const { mq } = fakeMatchMedia(true);
    vi.stubGlobal('matchMedia', () => mq);
    expect(initialReducedMotion()).toBe(true);
  });

  it('is false when matchMedia is unavailable (SSR guard)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(initialReducedMotion()).toBe(false);
  });

  it('notifies on a mid-session change and stops after unsubscribe (no leak)', () => {
    const { mq, fire, listenerCount } = fakeMatchMedia(false);
    vi.stubGlobal('matchMedia', () => mq);
    const onChange = vi.fn();
    const unsubscribe = subscribeReducedMotion(onChange);
    expect(listenerCount()).toBe(1);

    fire(true);
    expect(onChange).toHaveBeenCalledWith(true);

    unsubscribe();
    expect(listenerCount()).toBe(0);
    fire(false);
    expect(onChange).toHaveBeenCalledTimes(1); // no further calls after unsubscribe
  });

  it('subscribing without matchMedia is a no-op that returns a safe unsubscribe', () => {
    vi.stubGlobal('matchMedia', undefined);
    const onChange = vi.fn();
    expect(() => subscribeReducedMotion(onChange)()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('isDragGesture', () => {
  it('a 2px-movement tap (well under clickDistance) is NOT a drag', () => {
    // Regression: d3-drag fires 'drag' on every pointer move, including sub-pixel tremor, so the
    // handler must not flag a drag on the first move — only once travel crosses clickDistance.
    expect(isDragGesture({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
  });

  it("travel right at clickDistance is not yet a drag (matches d3-drag's own > comparison)", () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: CLICK_DISTANCE, y: 0 })).toBe(false);
  });

  it('travel beyond clickDistance IS a drag', () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: CLICK_DISTANCE + 1, y: 0 })).toBe(true);
  });

  it('measures Euclidean distance from the gesture origin, not per-axis', () => {
    // 3-4-5 triangle: 3px + 4px component moves = 5px total, which is > CLICK_DISTANCE (4).
    expect(isDragGesture({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true);
  });
});

describe('linkHop', () => {
  it('reads the far (more-peripheral) endpoint when target is the outer node', () => {
    const link = { source: node(1), target: node(2) };
    expect(linkHop(link)).toBe(2);
  });

  it('is direction-independent: same result when source/target are swapped', () => {
    // Edges aren't normalised by direction — a hop-2 edge may point periphery→centre instead of
    // centre→periphery, so `target` can be the LESS peripheral end.
    const link = { source: node(2), target: node(1) };
    expect(linkHop(link)).toBe(2);
  });

  it('handles an edge entirely within one ring', () => {
    const link = { source: node(1), target: node(1) };
    expect(linkHop(link)).toBe(1);
  });
});
