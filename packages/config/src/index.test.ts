import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_WEIGHTS, procedureGroup, requireEnv, sectorForCpv } from './index';

describe('risk weights', () => {
  it('sum to exactly one scoring budget', () => {
    const total = Object.values(DEFAULT_RISK_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBeCloseTo(1, 10);
  });
});

describe('sectorForCpv', () => {
  it('maps a known CPV division to its sector', () => {
    expect(sectorForCpv('15800000')).toMatchObject({
      code: '15',
      short: 'Храни',
      curated: true,
    });
  });

  it('extracts the 2-digit division from a full CPV code', () => {
    expect(sectorForCpv('45233120-6')?.code).toBe('45');
  });

  it('returns null for missing or unknown CPV divisions', () => {
    expect(sectorForCpv(null)).toBeNull();
    expect(sectorForCpv('99000000')).toBeNull();
  });
});

describe('procedureGroup', () => {
  it('maps a known procedure type to its display group', () => {
    expect(procedureGroup('Пряко договаряне')).toMatchObject({
      key: 'direct',
      competitive: false,
      label: 'Пряко / без обявление',
    });
  });

  it('falls back to the unknown bucket for unrecognised procedure types', () => {
    expect(procedureGroup('несъществуваща процедура')).toMatchObject({
      key: 'unknown',
      competitive: null,
      label: 'Неизвестна',
    });
  });
});

describe('requireEnv', () => {
  it('returns a present string value', () => {
    expect(requireEnv({ SIGMA_API_URL: 'https://example.test' }, 'SIGMA_API_URL')).toBe(
      'https://example.test',
    );
  });

  it('throws when the variable is missing', () => {
    expect(() => requireEnv({}, 'SIGMA_API_URL')).toThrow(
      'Missing required environment variable: SIGMA_API_URL',
    );
  });
});
