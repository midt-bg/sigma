import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialReducedMotion, linkHop, subscribeReducedMotion } from './useForceGraph';

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
