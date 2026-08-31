import { describe, expect, it } from 'vitest';
import { axisLabel, jitter, logMax, makeLx, multText, pick, relLabel } from './trends';

describe('pick', () => {
  it('accepts an allowed raw value', () => {
    expect(pick('q', ['m', 'q', 'y'] as const, 'q')).toBe('q');
  });

  it('falls back to the default for a value outside the allow-list (query-string poisoning guard)', () => {
    expect(pick('bogus', ['m', 'q', 'y'] as const, 'q')).toBe('q');
  });

  it('falls back to the default for null', () => {
    expect(pick(null, ['m', 'q', 'y'] as const, 'm')).toBe('m');
  });
});

describe('multText', () => {
  it('formats sub-10 multiples with a Bulgarian decimal comma', () => {
    expect(multText(2.4)).toBe('×2,4');
  });

  it('rounds to a whole number at 10× and above', () => {
    expect(multText(15.4)).toBe('×15');
  });
});

describe('relLabel', () => {
  it('flags well above the typical value with the ×-multiple', () => {
    const r = relLabel(1500, 1000);
    expect(r.cls).toBe('ov-rel-hi');
    expect(r.text).toContain('×1,5');
  });

  it('flags well below the typical value', () => {
    expect(relLabel(500, 1000)).toEqual({ text: 'под типичното', cls: 'ov-rel-lo' });
  });

  it('treats a non-positive median as unknown rather than dividing by zero', () => {
    expect(relLabel(500, 0)).toEqual({ text: '≈ типичното', cls: 'ov-rel-mid' });
  });

  it('reads as "typical" inside the 0.75–1.3× band', () => {
    expect(relLabel(1100, 1000).cls).toBe('ov-rel-mid');
  });
});

describe('jitter', () => {
  it('is deterministic for the same seed and index', () => {
    expect(jitter('45000', 3)).toBe(jitter('45000', 3));
  });

  it('varies by index for the same seed (spreads the dot cloud)', () => {
    expect(jitter('45000', 0)).not.toBe(jitter('45000', 1));
  });

  it('stays within the [-0.5, 0.5) jitter band', () => {
    for (let i = 0; i < 20; i += 1) {
      const j = jitter('cpv-group', i);
      expect(j).toBeGreaterThanOrEqual(-0.5);
      expect(j).toBeLessThan(0.5);
    }
  });
});

describe('logMax', () => {
  it('rounds up to the next power of ten above the largest group max', () => {
    expect(logMax([{ maxEur: 4_200_000 } as never])).toBe(10_000_000);
  });

  it('never drops below the 1e6 floor for small corpora', () => {
    expect(logMax([{ maxEur: 100 } as never])).toBe(1_000_000);
  });
});

describe('axisLabel', () => {
  it('formats millions with the М suffix', () => {
    expect(axisLabel(5_000_000)).toBe('5М');
  });

  it('formats sub-million values with the к suffix', () => {
    expect(axisLabel(50_000)).toBe('50к');
  });
});

describe('makeLx', () => {
  it('maps the log-min value to the left edge and gMax to the right edge', () => {
    const lx = makeLx(1_000_000);
    expect(lx(1_000)).toBeCloseTo(6, 5);
    expect(lx(1_000_000)).toBeCloseTo(314, 5);
  });

  it('clamps values below the log floor to the left edge', () => {
    const lx = makeLx(1_000_000);
    expect(lx(1)).toBeCloseTo(6, 5);
  });
});
