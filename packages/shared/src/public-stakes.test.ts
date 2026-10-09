import { describe, expect, it } from 'vitest';
import { DOCUMENTED_PUBLIC_STAKES, publicStakeSeatSql, publicStakeSql } from './public-stakes';

describe('the public stakes the register does not record', () => {
  it('gives each a company, a share, its owner and the source it is taken from', () => {
    expect(DOCUMENTED_PUBLIC_STAKES.length).toBeGreaterThan(0);
    for (const s of DOCUMENTED_PUBLIC_STAKES) {
      expect(s.eik).toMatch(/^\d{9}$/);
      expect(s.pct).toBeGreaterThan(0);
      expect(s.pct).toBeLessThanOrEqual(100);
      expect(s.owner.trim()).not.toBe('');
      expect(s.source.trim()).not.toBe('');
      expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.via) expect(s.via).toMatch(/^\d{9}$/);
    }
  });

  it('lists a company and owner once', () => {
    const keys = DOCUMENTED_PUBLIC_STAKES.map((s) => `${s.eik}|${s.owner}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the SQL that tells a company with a public stake', () => {
  it('reads the documented stakes, the public enterprises and the public owners the register records', () => {
    const sql = publicStakeSql('x.eik');
    for (const s of DOCUMENTED_PUBLIC_STAKES) expect(sql).toContain(`'${s.eik}'`);
    expect(sql).toContain('state_owned_eik');
    expect(sql).toContain('public_owned_eik');
    // Each owner pattern in the three spellings the register writes.
    for (const p of [
      "'община%'",
      "'Община%'",
      "'ОБЩИНА%'",
      "'%народна банка%'",
      "'%НАРОДНА БАНКА%'",
    ])
      expect(sql).toContain(p);
  });

  it('makes a seat — never a share — the held position', () => {
    const sql = publicStakeSeatSql('r');
    expect(sql).toContain("r.role NOT IN ('sole_owner', 'partner', 'trader')");
    expect(sql).toContain('r.eik');
  });
});
