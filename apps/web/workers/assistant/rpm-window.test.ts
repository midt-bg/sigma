import { describe, it, expect } from 'vitest';
import { RpmWindow, resolveGlobalRpm, DEFAULT_GLOBAL_RPM } from './rpm-window';

describe('resolveGlobalRpm', () => {
  it('defaults on a missing / non-numeric / < 1 value', () => {
    expect(resolveGlobalRpm(undefined)).toBe(DEFAULT_GLOBAL_RPM);
    expect(resolveGlobalRpm('')).toBe(DEFAULT_GLOBAL_RPM);
    expect(resolveGlobalRpm('abc')).toBe(DEFAULT_GLOBAL_RPM);
    expect(resolveGlobalRpm('0')).toBe(DEFAULT_GLOBAL_RPM);
    expect(resolveGlobalRpm('-1')).toBe(DEFAULT_GLOBAL_RPM);
  });

  it('accepts a valid value and clamps the ceiling', () => {
    expect(resolveGlobalRpm('30')).toBe(30);
    expect(resolveGlobalRpm('120')).toBe(120);
    expect(resolveGlobalRpm('99999999')).toBe(100_000);
  });
});

describe('RpmWindow', () => {
  it('admits up to the limit within a window, then opens the breaker', () => {
    const w = new RpmWindow(3, 60_000);
    expect(w.admit(1_000).allowed).toBe(true); // used 1
    expect(w.admit(1_100).allowed).toBe(true); // used 2
    const third = w.admit(1_200);
    expect(third).toMatchObject({ allowed: true, used: 3, limit: 3 });
    const fourth = w.admit(1_300);
    expect(fourth.allowed).toBe(false);
    expect(fourth.used).toBe(3);
    // Retry-After points at the roll of the window that started at the first admit (1_000 + 60_000).
    expect(fourth.retryAfterMs).toBe(1_000 + 60_000 - 1_300);
  });

  it('rolls the window and re-admits once the period elapses', () => {
    const w = new RpmWindow(1, 60_000);
    expect(w.admit(0).allowed).toBe(true);
    expect(w.admit(59_999).allowed).toBe(false); // still in the first window
    expect(w.admit(60_000).allowed).toBe(true); // window rolled → fresh budget
    expect(w.admit(60_001).allowed).toBe(false); // saturated again
  });

  it('a limit of 1 admits exactly one call per window', () => {
    const w = new RpmWindow(1);
    expect(w.admit(0).allowed).toBe(true);
    expect(w.admit(1).allowed).toBe(false);
  });
});
