import { describe, it, expect } from 'vitest';
import { buildDedupRequest, type PeriodBounds } from './dedup-request';
import { SingleFlight } from './single-flight';
import { freshnessToken, type DedupKv } from './dedup';

// Model-free proof of the partial-period dedup contrast: drive the REAL request-shaping
// (buildDedupRequest) into the REAL single-flight/KV machinery with a fake report, so we validate
// end-to-end hit-vs-regenerate behaviour without a live model. Mirrors the deployed A/B: two DIFFERENT
// submissions (distinct clientRequestIds, as real re-asks carry) asking the same question — a settled
// period must reuse the first report (cross-submission L1 hit); a still-settling period must regenerate.

class FakeKv implements DedupKv {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const FRESH = freshnessToken({ refreshedAt: '2026-07-05T00:00:00Z', buildId: 'b1' });
const alwaysPresent = async () => true;

// „за 2025" asked in 2026 — fully elapsed, past the ingest-lag horizon → recencyCaveat=false (settled).
const Y2025: PeriodBounds = { sinceIso: '2025-01-01', untilIso: '2026-01-01' };
// „за 2026" mid-year — clamped to-date, still accruing → recencyCaveat=true (settling).
const Y2026: PeriodBounds = { sinceIso: '2026-01-01', untilIso: '2026-07-06' };

describe('dedup settling gate — end-to-end through single-flight (no model)', () => {
  it('a SETTLED period reuses the first report across two different submissions (cross-submission L1 hit)', async () => {
    const kv = new FakeKv();
    const question = 'топ 3 възложители по стойност за 2025';

    // Submission A generates and records.
    const a = buildDedupRequest({
      clientRequestId: 'sub-a',
      prompt: question,
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    expect(a.payloads.some((p) => p.layer === 'L1')).toBe(true);
    const sfA = new SingleFlight({ kv, r2Exists: alwaysPresent });
    expect((await sfA.claim(a.signals, FRESH)).role).toBe('driver');
    await sfA.complete(a.payloads, FRESH, {
      reportId: 'r_2025',
      createdAt: '2026-07-05T09:00:00Z',
    });

    // Submission B — DIFFERENT clientRequestId, same question+period, a separate isolate.
    const b = buildDedupRequest({
      clientRequestId: 'sub-b',
      prompt: question,
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    const sfB = new SingleFlight({ kv, r2Exists: alwaysPresent });
    const hit = await sfB.claim(b.signals, FRESH);
    // L0 misses (different submission id) → L1 hits: the two people see the SAME 2025 report.
    expect(hit).toMatchObject({ role: 'hit', reportId: 'r_2025', layer: 'L1' });
  });

  it('a SETTLING period regenerates for a second submission — never cross-submission reuse', async () => {
    const kv = new FakeKv();
    const question = 'топ 3 възложители по стойност за 2026';

    const a = buildDedupRequest({
      clientRequestId: 'sub-a',
      prompt: question,
      period: Y2026,
      periodSettling: true,
      freshness: FRESH,
    });
    // The fix: no L1 layer is recorded for a settling period, so nothing keys on prompt+period.
    expect(a.payloads.some((p) => p.layer === 'L1')).toBe(false);
    const sfA = new SingleFlight({ kv, r2Exists: alwaysPresent });
    expect((await sfA.claim(a.signals, FRESH)).role).toBe('driver');
    await sfA.complete(a.payloads, FRESH, {
      reportId: 'r_2026_first',
      createdAt: '2026-07-05T09:00:00Z',
    });

    // Submission B — different clientRequestId, same question+period.
    const b = buildDedupRequest({
      clientRequestId: 'sub-b',
      prompt: question,
      period: Y2026,
      periodSettling: true,
      freshness: FRESH,
    });
    const sfB = new SingleFlight({ kv, r2Exists: alwaysPresent });
    // Only the first submission's L0 was recorded; B's L0 differs and there is no L1 → regenerate,
    // so the second asker gets a FRESH report reflecting any 2026 contracts landed since. (Pre-fix this
    // was a cross-submission L1 hit — a stale under-count of a named partial window.)
    expect((await sfB.claim(b.signals, FRESH)).role).toBe('driver');
  });
});
