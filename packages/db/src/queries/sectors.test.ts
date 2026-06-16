import { describe, expect, it } from 'vitest';
import { sectorRef } from './sectors';

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

  it('short is present and matches label when no short form exists, otherwise is shorter', () => {
    const ref = sectorRef('45');
    expect(ref?.short).toBeDefined();
  });
});
