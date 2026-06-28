import { describe, expect, it } from 'vitest';
import { sectorOptions, sectorRef } from './sectors';

describe('sectorRef', () => {
  it('resolves a valid 2-digit CPV division to a SectorRef', () => {
    const ref = sectorRef('45');
    expect(ref).not.toBeNull();
    expect(ref?.code).toBe('45');
    expect(typeof ref?.label).toBe('string');
    expect(ref?.label.length).toBeGreaterThan(0);
  });

  it('returns null for a null input', () => {
    expect(sectorRef(null)).toBeNull();
  });

  it('returns null for an undefined input', () => {
    expect(sectorRef(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(sectorRef('')).toBeNull();
  });

  it('returns null for an unrecognised division code', () => {
    expect(sectorRef('99')).toBeNull();
  });

  it('always returns a non-empty short field', () => {
    const ref = sectorRef('45');
    expect(typeof ref?.short).toBe('string');
    expect(ref!.short.length).toBeGreaterThan(0);
  });
});

const fakeSectorDb = (divisions: string[]) =>
  ({
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: divisions.map((division) => ({ division })) }),
      }),
    }),
  }) as unknown as D1Database;

describe('sectorOptions', () => {
  it('maps sector_totals divisions (in order) to SectorRef[], dropping unknown codes', async () => {
    const opts = await sectorOptions(fakeSectorDb(['45', '99', '33']));
    expect(opts.map((s) => s.code)).toEqual(['45', '33']); // 99 is not a CPV division
    expect(opts.every((s) => s.label.length > 0 && s.short.length > 0)).toBe(true);
  });

  it('returns an empty array when there are no sector rows', async () => {
    expect(await sectorOptions(fakeSectorDb([]))).toEqual([]);
  });
});
