import { describe, it, expect } from 'vitest';
import {
  freshnessToken,
  encodeFields,
  dedupKey,
  resultFingerprint,
  lookup,
  record,
  resolveReport,
  DEFAULT_TTL_SECONDS,
  type DedupKv,
  type DedupPayload,
} from './dedup';

/** In-memory KV with a put-spy and an injectable get failure, for adversarial paths. */
class FakeKv implements DedupKv {
  store = new Map<string, string>();
  puts: { key: string; value: string; ttl?: number }[] = [];
  failGet = false;

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error('kv unavailable');
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, ttl: options?.expirationTtl });
    this.store.set(key, value);
  }
}

const FRESH = freshnessToken({ refreshedAt: '2026-06-24T00:00:00Z', buildId: 'abc123' });
const report = { reportId: 'rep_1', createdAt: '2026-06-24T01:02:03Z' };

describe('freshnessToken', () => {
  it('reuses the csv-export refreshed_at derivation and is composite', () => {
    expect(freshnessToken({ refreshedAt: '2026-06-24T00:00:00Z', buildId: 'abc-123' })).toBe(
      'd:20260624T000000Z|c:abc123',
    );
  });

  it('changes when either the data or the code half changes', () => {
    const base = freshnessToken({ refreshedAt: 'A', buildId: 'X' });
    expect(freshnessToken({ refreshedAt: 'B', buildId: 'X' })).not.toBe(base);
    expect(freshnessToken({ refreshedAt: 'A', buildId: 'Y' })).not.toBe(base);
  });
});

describe('encodeFields injectivity', () => {
  it('cannot collide across field boundaries (length-prefixed)', () => {
    const a = Array.from(encodeFields('L2', ['ab', 'c']));
    const b = Array.from(encodeFields('L2', ['a', 'bc']));
    expect(a).not.toEqual(b);
  });

  it('separates by domain', () => {
    const a = Array.from(encodeFields('L1', ['x']));
    const b = Array.from(encodeFields('L2', ['x']));
    expect(a).not.toEqual(b);
  });
});

describe('dedupKey', () => {
  it('is deterministic', async () => {
    const p: DedupPayload = { layer: 'L2', sql: 'SELECT 1', params: [1, 'a'] };
    expect(await dedupKey(p, FRESH)).toBe(await dedupKey(p, FRESH));
  });

  it('namespaces by layer and never collides between layers', async () => {
    const k0 = await dedupKey({ layer: 'L0', clientRequestId: 'x' }, FRESH);
    const k2 = await dedupKey({ layer: 'L2', sql: 'x', params: [] }, FRESH);
    expect(k0.startsWith('dedup:L0:')).toBe(true);
    expect(k2.startsWith('dedup:L2:')).toBe(true);
    expect(k0).not.toBe(k2);
  });

  it('L2 key is identical for differently-phrased prompts that resolve to the same SQL+params', async () => {
    // The consistency guarantee: L2 keys only on resolved SQL, never on wording.
    const a = await dedupKey(
      { layer: 'L2', sql: 'SELECT * FROM t WHERE y=2026', params: [] },
      FRESH,
    );
    const b = await dedupKey(
      { layer: 'L2', sql: 'SELECT * FROM t WHERE y=2026', params: [] },
      FRESH,
    );
    expect(a).toBe(b);
  });

  it('L2 normalises whitespace but distinguishes different params', async () => {
    const spaced = await dedupKey({ layer: 'L2', sql: 'SELECT   1', params: [] }, FRESH);
    const tight = await dedupKey({ layer: 'L2', sql: 'SELECT 1', params: [] }, FRESH);
    expect(spaced).toBe(tight);
    const other = await dedupKey({ layer: 'L2', sql: 'SELECT 1', params: [2] }, FRESH);
    expect(other).not.toBe(tight);
  });

  it('canonicalises object key order in params', async () => {
    const a = await dedupKey({ layer: 'L2', sql: 's', params: [{ a: 1, b: 2 }] }, FRESH);
    const b = await dedupKey({ layer: 'L2', sql: 's', params: [{ b: 2, a: 1 }] }, FRESH);
    expect(a).toBe(b);
  });

  it('folds freshness for L2 but not for L0', async () => {
    const other = freshnessToken({ refreshedAt: 'later', buildId: 'abc123' });
    expect(await dedupKey({ layer: 'L2', sql: 's', params: [] }, FRESH)).not.toBe(
      await dedupKey({ layer: 'L2', sql: 's', params: [] }, other),
    );
    expect(await dedupKey({ layer: 'L0', clientRequestId: 'c' }, FRESH)).toBe(
      await dedupKey({ layer: 'L0', clientRequestId: 'c' }, other),
    );
  });
});

describe('resultFingerprint', () => {
  it('is order-sensitive across rows', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    expect(await resultFingerprint(rows)).not.toBe(await resultFingerprint([...rows].reverse()));
  });

  it('is insensitive to key order within a row', async () => {
    expect(await resultFingerprint([{ a: 1, b: 2 }])).toBe(
      await resultFingerprint([{ b: 2, a: 1 }]),
    );
  });
});

describe('lookup / record round-trip', () => {
  it('returns the recorded report for each layer', async () => {
    const kv = new FakeKv();
    const payloads: DedupPayload[] = [
      { layer: 'L0', clientRequestId: 'c' },
      { layer: 'L1', prompt: 'p', filterContext: 'f' },
      { layer: 'L2', sql: 's', params: [] },
      { layer: 'L2.5', resultFingerprint: 'fp' },
      { layer: 'L3', toolName: 't', args: { x: 1 } },
    ];
    for (const p of payloads) {
      await record(kv, p, FRESH, report);
      const hit = await lookup(kv, p, FRESH);
      expect(hit).toEqual({ reportId: 'rep_1', createdAt: report.createdAt, layer: p.layer });
    }
  });
});

describe('fail toward regeneration', () => {
  it('misses when the stored freshness no longer matches — L2 (key-folded)', async () => {
    const kv = new FakeKv();
    await record(kv, { layer: 'L2', sql: 's', params: [] }, FRESH, report);
    const stale = freshnessToken({ refreshedAt: 'new', buildId: 'abc123' });
    expect(await lookup(kv, { layer: 'L2', sql: 's', params: [] }, stale)).toBeNull();
  });

  it('misses when the stored freshness no longer matches — L0 (key not folded)', async () => {
    const kv = new FakeKv();
    // L0 key ignores freshness, so the entry IS found by key, then rejected on token mismatch.
    await record(kv, { layer: 'L0', clientRequestId: 'c' }, FRESH, report);
    const stale = freshnessToken({ refreshedAt: 'new', buildId: 'abc123' });
    expect(await lookup(kv, { layer: 'L0', clientRequestId: 'c' }, stale)).toBeNull();
  });

  it('misses (does not throw) when KV get fails', async () => {
    const kv = new FakeKv();
    kv.failGet = true;
    expect(await lookup(kv, { layer: 'L2', sql: 's', params: [] }, FRESH)).toBeNull();
  });

  it('misses on a malformed stored value', async () => {
    const kv = new FakeKv();
    const key = await dedupKey({ layer: 'L2', sql: 's', params: [] }, FRESH);
    kv.store.set(key, 'not json');
    expect(await lookup(kv, { layer: 'L2', sql: 's', params: [] }, FRESH)).toBeNull();
    kv.store.set(key, JSON.stringify({ reportId: 'x' })); // missing fields
    expect(await lookup(kv, { layer: 'L2', sql: 's', params: [] }, FRESH)).toBeNull();
  });
});

describe('record TTL', () => {
  it('applies the per-layer default TTL', async () => {
    const kv = new FakeKv();
    await record(kv, { layer: 'L0', clientRequestId: 'c' }, FRESH, report);
    await record(kv, { layer: 'L3', toolName: 't', args: 1 }, FRESH, report);
    expect(kv.puts[0].ttl).toBe(DEFAULT_TTL_SECONDS.L0);
    expect(kv.puts[1].ttl).toBe(DEFAULT_TTL_SECONDS.L3);
  });

  it('honours an explicit TTL override', async () => {
    const kv = new FakeKv();
    await record(kv, { layer: 'L2', sql: 's', params: [] }, FRESH, report, 42);
    expect(kv.puts[0].ttl).toBe(42);
  });
});

describe('resolveReport', () => {
  it('escalates L0 → L1 → L2 → L2.5 and returns the first hit', async () => {
    const kv = new FakeKv();
    await record(kv, { layer: 'L2', sql: 's', params: [] }, FRESH, report);
    const hit = await resolveReport(kv, { sql: 's', params: [] }, FRESH);
    expect(hit?.layer).toBe('L2');
    expect(hit?.reportId).toBe('rep_1');
  });

  it('prefers L0 when an idempotency hit exists', async () => {
    const kv = new FakeKv();
    await record(kv, { layer: 'L0', clientRequestId: 'c' }, FRESH, report);
    await record(kv, { layer: 'L2', sql: 's', params: [] }, FRESH, {
      reportId: 'rep_2',
      createdAt: report.createdAt,
    });
    const hit = await resolveReport(kv, { clientRequestId: 'c', sql: 's', params: [] }, FRESH);
    expect(hit?.layer).toBe('L0');
    expect(hit?.reportId).toBe('rep_1');
  });

  it('returns null when no layer signal is present', async () => {
    expect(await resolveReport(new FakeKv(), {}, FRESH)).toBeNull();
  });
});
