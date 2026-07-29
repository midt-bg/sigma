// Adversarial coverage for the canonical encoder behind dedup keys and result fingerprints.
//
// These exercise the value-erasure traps that `JSON.stringify` falls into (Date→{}, NaN/±Infinity→
// null, undefined→null, bigint throws). Every case is a collision a reviewer can hand-construct in
// seconds: two distinct inputs that MUST NOT share a key, because a shared key serves one question's
// numbers for another (#97). We assert through the public surface (dedupKey / resultFingerprint),
// not the private encoder — behaviour, not internals.
import { describe, expect, it } from 'vitest';
import { dedupKey, resultFingerprint, type DedupPayload } from './dedup';

const FRESH = 'd:20260624|c:b1';
const l2 = (params: readonly unknown[]): DedupPayload => ({ layer: 'L2', sql: 's', params });
const l3 = (args: unknown): DedupPayload => ({ layer: 'L3', toolName: 't', args });

describe('canonical encoding — distinct values never collide', () => {
  it('keeps two distinct Date params apart (JSON.stringify would map both to {})', async () => {
    const a = await dedupKey(l2([new Date('2025-01-01T00:00:00Z')]), FRESH);
    const b = await dedupKey(l2([new Date('2026-01-01T00:00:00Z')]), FRESH);
    expect(a).not.toBe(b);
  });

  it('separates NaN, +Infinity, -Infinity, null and undefined (all → "null" under JSON.stringify)', async () => {
    const keys = await Promise.all(
      [NaN, Infinity, -Infinity, null, undefined].map((v) => dedupKey(l2([v]), FRESH)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('hashes bigint params instead of throwing, and keeps distinct bigints apart', async () => {
    const a = await dedupKey(l2([1n]), FRESH);
    const b = await dedupKey(l2([2n]), FRESH);
    expect(a).not.toBe(b);
  });

  it('does not let a bigint alias the equal-valued number (1n ≠ 1)', async () => {
    const big = await dedupKey(l2([1n]), FRESH);
    const num = await dedupKey(l2([1]), FRESH);
    expect(big).not.toBe(num);
  });

  it('does not let a tag token alias the same text as a string param (date:0 ≠ "date:0")', async () => {
    const tagged = await dedupKey(l2([new Date(0)]), FRESH);
    const literal = await dedupKey(l2(['date:0']), FRESH);
    expect(tagged).not.toBe(literal);
  });
});

describe('canonical encoding — meaning-preserving invariants still hold', () => {
  it('is insensitive to object key order in L3 args', async () => {
    const a = await dedupKey(l3({ a: 1, b: 2 }), FRESH);
    const b = await dedupKey(l3({ b: 2, a: 1 }), FRESH);
    expect(a).toBe(b);
  });

  it('is sensitive to array order in params (order is semantically meaningful)', async () => {
    const a = await dedupKey(l2([1, 2]), FRESH);
    const b = await dedupKey(l2([2, 1]), FRESH);
    expect(a).not.toBe(b);
  });
});

describe('resultFingerprint — Date-valued rows stay distinct (L2.5 headline)', () => {
  it('fingerprints two rows differing only by a Date cell differently', async () => {
    const a = await resultFingerprint([{ id: 1, at: new Date('2025-06-01T00:00:00Z') }]);
    const b = await resultFingerprint([{ id: 1, at: new Date('2026-06-01T00:00:00Z') }]);
    expect(a).not.toBe(b);
  });

  it('is stable for identical rows (determinism)', async () => {
    const rows = [{ id: 1, name: 'Алфа' }];
    expect(await resultFingerprint(rows)).toBe(await resultFingerprint(rows));
  });
});

describe('canonical encoding — signed zero stays injective', () => {
  it('keeps -0 and +0 in distinct keys (JSON.stringify would erase the sign)', async () => {
    expect(await dedupKey(l2([-0]), FRESH)).not.toBe(await dedupKey(l2([0]), FRESH));
  });
});
