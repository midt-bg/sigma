import { describe, it, expect } from 'vitest';
import { SingleFlight, type ProgressEvent, type GeneratorResult } from './single-flight';
import {
  freshnessToken,
  record,
  type DedupKv,
  type DedupPayload,
  type ResolveSignals,
} from './dedup';

class FakeKv implements DedupKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

/** Flush microtasks AND the real async crypto in resolveLive (a macrotask boundary). */
const flush = () => new Promise((r) => setTimeout(r, 0));

const FRESH = freshnessToken({ refreshedAt: '2026-06-24T00:00:00Z', buildId: 'b1' });
const SIGNALS: ResolveSignals = { sql: 's', params: [] };
const RECORD_AS: DedupPayload[] = [{ layer: 'L2', sql: 's', params: [] }];
const REPORT: GeneratorResult = { reportId: 'rep_1', createdAt: '2026-06-24T01:00:00Z' };
const alwaysPresent = async () => true;

describe('SingleFlight — claim (driver vs waiter)', () => {
  it('the first claim is the driver, the rest are waiters', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    const first = await sf.claim(SIGNALS, FRESH);
    const second = await sf.claim(SIGNALS, FRESH);
    expect(first.role).toBe('driver');
    expect(second.role).toBe('waiter');
  });

  it('exactly one driver under two interleaved claims (atomic check-and-set)', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    const [a, b] = await Promise.all([sf.claim(SIGNALS, FRESH), sf.claim(SIGNALS, FRESH)]);
    expect(new Set([a.role, b.role])).toEqual(new Set(['driver', 'waiter']));
  });

  it('a waiter resolves with the driver’s report when the driver completes', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    const waiter = await sf.claim(SIGNALS, FRESH);
    if (waiter.role !== 'waiter') throw new Error('expected waiter');

    await sf.complete(RECORD_AS, FRESH, REPORT);
    await expect(waiter.result).resolves.toMatchObject({ reportId: 'rep_1' });
  });

  it('after completion a fresh claim is a live cache hit, not a new driver', async () => {
    const kv = new FakeKv();
    const sf = new SingleFlight({ kv, r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    await sf.complete(RECORD_AS, FRESH, REPORT);

    const next = await sf.claim(SIGNALS, FRESH);
    expect(next).toMatchObject({ role: 'hit', reportId: 'rep_1', layer: 'L2' });
  });
});

describe('SingleFlight — live cache hit', () => {
  it('claim returns a hit without designating a driver', async () => {
    const kv = new FakeKv();
    await record(kv, RECORD_AS[0], FRESH, REPORT);
    const sf = new SingleFlight({ kv, r2Exists: alwaysPresent });
    const out = await sf.claim(SIGNALS, FRESH);
    expect(out).toMatchObject({ role: 'hit', reportId: 'rep_1', layer: 'L2' });
  });

  it('a KV hit whose R2 artifact is gone is a miss → driver', async () => {
    const kv = new FakeKv();
    await record(kv, RECORD_AS[0], FRESH, REPORT);
    const sf = new SingleFlight({ kv, r2Exists: async () => false });
    const out = await sf.claim(SIGNALS, FRESH);
    expect(out.role).toBe('driver');
  });

  it('an r2Exists throw is a miss → driver (fail toward regeneration)', async () => {
    const kv = new FakeKv();
    await record(kv, RECORD_AS[0], FRESH, REPORT);
    const sf = new SingleFlight({
      kv,
      r2Exists: async () => {
        throw new Error('r2 unreachable');
      },
    });
    const out = await sf.claim(SIGNALS, FRESH);
    expect(out.role).toBe('driver');
  });
});

describe('SingleFlight — fail toward regeneration', () => {
  it('fail() rejects waiters and the next claim regenerates', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    const waiter = await sf.claim(SIGNALS, FRESH);
    if (waiter.role !== 'waiter') throw new Error('expected waiter');

    sf.fail(new Error('driver crashed'));
    await expect(waiter.result).rejects.toThrow('driver crashed');

    const next = await sf.claim(SIGNALS, FRESH);
    expect(next.role).toBe('driver'); // regenerates
  });
});

describe('SingleFlight — recording', () => {
  it('records every supplied layer so any of them dedups next time', async () => {
    const kv = new FakeKv();
    const sf = new SingleFlight({ kv, r2Exists: alwaysPresent });
    await sf.claim({ clientRequestId: 'c1' }, FRESH); // driver
    const layers: DedupPayload[] = [
      { layer: 'L0', clientRequestId: 'c1' },
      { layer: 'L1', prompt: 'топ 10', filterContext: 'f' },
      { layer: 'L2.5', resultFingerprint: 'fp' },
    ];
    await sf.complete(layers, FRESH, REPORT);

    const byL0 = new SingleFlight({ kv, r2Exists: alwaysPresent });
    const byL1 = new SingleFlight({ kv, r2Exists: alwaysPresent });
    const byL25 = new SingleFlight({ kv, r2Exists: alwaysPresent });
    expect((await byL0.claim({ clientRequestId: 'c1' }, FRESH)).role).toBe('hit');
    expect((await byL1.claim({ prompt: 'топ 10', filterContext: 'f' }, FRESH)).role).toBe('hit');
    expect((await byL25.claim({ resultFingerprint: 'fp' }, FRESH)).role).toBe('hit');
  });

  it('swallows a failed cache write and still resolves waiters', async () => {
    const failPut: DedupKv = {
      get: async () => null,
      put: async () => {
        throw new Error('kv down');
      },
    };
    const sf = new SingleFlight({ kv: failPut, r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    const waiter = await sf.claim(SIGNALS, FRESH);
    if (waiter.role !== 'waiter') throw new Error('expected waiter');
    await sf.complete(RECORD_AS, FRESH, REPORT); // record throws internally, swallowed
    await expect(waiter.result).resolves.toMatchObject({ reportId: 'rep_1' });
  });
});

describe('SingleFlight — cross-isolate KV backstop', () => {
  it('a second instance dedups on the first instance’s recorded report', async () => {
    const kv = new FakeKv();
    const a = new SingleFlight({ kv, r2Exists: alwaysPresent });
    const b = new SingleFlight({ kv, r2Exists: alwaysPresent });
    expect((await a.claim(SIGNALS, FRESH)).role).toBe('driver');
    await a.complete(RECORD_AS, FRESH, REPORT);
    expect(await b.claim(SIGNALS, FRESH)).toMatchObject({ role: 'hit', reportId: 'rep_1' });
  });
});

describe('SingleFlight — progress', () => {
  it('postProgress reaches a subscribed waiter, with late catch-up', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    const planning: ProgressEvent = { phase: 'planning', label: 'P' };
    sf.postProgress(planning); // before the waiter subscribes

    const waiter = await sf.claim(SIGNALS, FRESH);
    if (waiter.role !== 'waiter') throw new Error('expected waiter');
    const seen: ProgressEvent[] = [];
    waiter.subscribe((e) => seen.push(e)); // catch-up delivers the last event immediately
    const composing: ProgressEvent = { phase: 'composing', label: 'C' };
    sf.postProgress(composing);

    expect(seen).toContainEqual(planning); // catch-up
    expect(seen).toContainEqual(composing); // live
    await sf.complete(RECORD_AS, FRESH, REPORT);
  });

  it('a throwing subscriber does not starve other waiters', async () => {
    const sf = new SingleFlight({ kv: new FakeKv(), r2Exists: alwaysPresent });
    await sf.claim(SIGNALS, FRESH); // driver
    const w1 = await sf.claim(SIGNALS, FRESH);
    const w2 = await sf.claim(SIGNALS, FRESH);
    if (w1.role !== 'waiter' || w2.role !== 'waiter') throw new Error('expected waiters');
    w1.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const good: ProgressEvent[] = [];
    w2.subscribe((e) => good.push(e));
    sf.postProgress({ phase: 'querying', label: 'Q' });
    expect(good).toContainEqual({ phase: 'querying', label: 'Q' });
    await sf.complete(RECORD_AS, FRESH, REPORT);
  });
});
