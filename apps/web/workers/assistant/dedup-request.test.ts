import { describe, it, expect } from 'vitest';
import { buildDedupRequest, canonicalFilterContext, type PeriodBounds } from './dedup-request';

const FRESH = 'd:2026070412|c:build9';
const JULY: PeriodBounds = { sinceIso: '2026-07-01', untilIso: '2026-08-01' };
const AUG: PeriodBounds = { sinceIso: '2026-08-01', untilIso: '2026-09-01' };
// A fully-settled prior year asked in 2026 — the one period shape that is safe to dedup.
const Y2025: PeriodBounds = { sinceIso: '2025-01-01', untilIso: '2026-01-01' };

describe('canonicalFilterContext', () => {
  it('folds resolved period bounds (not the phrase)', () => {
    expect(canonicalFilterContext(JULY, undefined)).toBe('p:2026-07-01..2026-08-01');
  });

  it('distinguishes two periods for the same question — the concrete #97 fix', () => {
    expect(canonicalFilterContext(JULY, undefined)).not.toBe(
      canonicalFilterContext(AUG, undefined),
    );
  });

  it('appends and trims an FE filter', () => {
    expect(canonicalFilterContext(JULY, '  възложител=Х ')).toBe(
      'p:2026-07-01..2026-08-01|f:възложител=Х',
    );
    expect(canonicalFilterContext(undefined, 'сектор=строителство')).toBe('f:сектор=строителство');
  });

  it('is empty when neither is present', () => {
    expect(canonicalFilterContext(undefined, undefined)).toBe('');
    expect(canonicalFilterContext(undefined, '   ')).toBe('');
  });
});

describe('buildDedupRequest', () => {
  it('L0 only from clientRequestId when there is no prompt', () => {
    const r = buildDedupRequest({
      clientRequestId: 'req-abc_1',
      prompt: '   ',
      freshness: FRESH,
    });
    expect(r.signals).toEqual({ clientRequestId: 'req-abc_1' });
    expect(r.payloads).toEqual([{ layer: 'L0', clientRequestId: 'req-abc_1' }]);
    expect(r.doName).toBe(`L0|${FRESH}|req-abc_1`);
  });

  it('L1 folds the resolved bounds of a settled period; signals + payload agree; DO keyed on L1', () => {
    const r = buildDedupRequest({
      prompt: 'топ 3 възложители за 2025',
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    expect(r.signals).toEqual({
      prompt: 'топ 3 възложители за 2025',
      filterContext: 'p:2025-01-01..2026-01-01',
    });
    expect(r.payloads).toEqual([
      {
        layer: 'L1',
        prompt: 'топ 3 възложители за 2025',
        filterContext: 'p:2025-01-01..2026-01-01',
      },
    ]);
    expect(r.doName).toBe(`L1|${FRESH}|топ 3 възложители за 2025|p:2025-01-01..2026-01-01`);
  });

  it('carries both L0 and L1 for a settled period; DO prefers the stronger L1 key', () => {
    const r = buildDedupRequest({
      clientRequestId: 'req-1',
      prompt: 'топ 3 възложители за 2025',
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    expect(r.payloads).toEqual([
      { layer: 'L0', clientRequestId: 'req-1' },
      {
        layer: 'L1',
        prompt: 'топ 3 възложители за 2025',
        filterContext: 'p:2025-01-01..2026-01-01',
      },
    ]);
    expect(r.signals).toEqual({
      clientRequestId: 'req-1',
      prompt: 'топ 3 възложители за 2025',
      filterContext: 'p:2025-01-01..2026-01-01',
    });
    expect(r.doName).toBe(`L1|${FRESH}|топ 3 възложители за 2025|p:2025-01-01..2026-01-01`);
  });

  it('skips L1 for a still-settling period (recencyCaveat) — the partial-period accuracy fix', () => {
    // „за 2026" mid-2026: the period is still accruing contracts, and the global freshness token does not
    // invalidate within a data epoch → an L1 hit would under-count a NAMED partial window. Skip L1; a
    // clientRequestId still gives L0 (collapses a double-submit of the SAME click, not stale reuse).
    const r = buildDedupRequest({
      clientRequestId: 'req-2026',
      prompt: 'топ 3 възложители за 2026',
      period: { sinceIso: '2026-01-01', untilIso: '2026-07-06' }, // clamped to-date; recencyCaveat=true
      periodSettling: true,
      freshness: FRESH,
    });
    expect(r.payloads).toEqual([{ layer: 'L0', clientRequestId: 'req-2026' }]);
    expect(r.signals.prompt).toBeUndefined();
    expect(r.signals.filterContext).toBeUndefined();
    expect(r.doName).toBe(`L0|${FRESH}|req-2026`);
  });

  it('a settling period with no L0 key skips dedup entirely (always regenerate)', () => {
    const r = buildDedupRequest({
      prompt: 'топ 3 възложители за 2026',
      period: { sinceIso: '2026-01-01', untilIso: '2026-07-06' },
      periodSettling: true,
      freshness: FRESH,
    });
    expect(r.payloads).toEqual([]);
    expect(r.doName).toBeNull();
  });

  it('the SAME period settled (recencyCaveat=false) dedups; settling flips it off — the switch', () => {
    const deduped = buildDedupRequest({
      prompt: 'топ 3 възложители за 2025',
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    expect(deduped.doName).toBe(`L1|${FRESH}|топ 3 възложители за 2025|p:2025-01-01..2026-01-01`);

    const skipped = buildDedupRequest({
      prompt: 'топ 3 възложители за 2025',
      period: Y2025,
      periodSettling: true,
      freshness: FRESH,
    });
    expect(skipped.doName).toBeNull();
  });

  it('an all-time question (no resolved period) skips L1 — only explicitly-settled periods dedup', () => {
    // „най-големите възложители" with no date phrase spans the still-growing present → NOT a fixed window.
    // With a clientRequestId it keeps L0 (per-submission idempotency); without one it does not dedup.
    const withReqId = buildDedupRequest({
      clientRequestId: 'req-all',
      prompt: 'най-големите възложители',
      freshness: FRESH,
    });
    expect(withReqId.payloads).toEqual([{ layer: 'L0', clientRequestId: 'req-all' }]);
    expect(withReqId.signals.prompt).toBeUndefined();
    expect(withReqId.doName).toBe(`L0|${FRESH}|req-all`);

    const anon = buildDedupRequest({ prompt: 'най-големите възложители', freshness: FRESH });
    expect(anon.payloads).toEqual([]);
    expect(anon.doName).toBeNull();
  });

  it('an unresolvable relative phrase resolves to no period → skips L1, falling back to L0', () => {
    const r = buildDedupRequest({
      clientRequestId: 'req-2',
      prompt: 'какво стана преди няколко месеца', // temporal.ts returns null → no period
      freshness: FRESH,
    });
    expect(r.payloads).toEqual([{ layer: 'L0', clientRequestId: 'req-2' }]);
    expect(r.signals.prompt).toBeUndefined();
    expect(r.doName).toBe(`L0|${FRESH}|req-2`);
  });

  it('DO key normalises whitespace so trivially-different phrasings collapse', () => {
    const a = buildDedupRequest({
      prompt: 'разходи   за   2025',
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    const b = buildDedupRequest({
      prompt: '  разходи за 2025  ',
      period: Y2025,
      periodSettling: false,
      freshness: FRESH,
    });
    expect(a.doName).toBe(b.doName);
  });

  it('DO key normalises the filterContext too, so whitespace-variant filters collapse', () => {
    const withDoubleSpace = buildDedupRequest({
      prompt: 'разходи',
      period: Y2025,
      periodSettling: false,
      filterContext: 'сектор  =  строителство',
      freshness: FRESH,
    });
    const withSingleSpace = buildDedupRequest({
      prompt: 'разходи',
      period: Y2025,
      periodSettling: false,
      filterContext: 'сектор = строителство',
      freshness: FRESH,
    });
    expect(withDoubleSpace.doName).toBe(withSingleSpace.doName);
  });

  it('folds an FE filterContext into L1 alongside the settled period', () => {
    const r = buildDedupRequest({
      prompt: 'разходи за 2025',
      period: Y2025,
      periodSettling: false,
      filterContext: 'сектор=здравеопазване',
      freshness: FRESH,
    });
    expect(r.signals.filterContext).toBe('p:2025-01-01..2026-01-01|f:сектор=здравеопазване');
  });

  it('escapes the DO-name delimiter so a `|` in free text cannot shift a field boundary', () => {
    // filterContext is FE-supplied free text and may carry a literal `|`. escapeDoField turns every `|`
    // inside a field into `\|`, so prompt and context stay unambiguous fields — a `|` in one never reads
    // as the separator. (KV lookup was already injective via encodeFields; this matches the single-flight
    // routing key.) Without escaping, `сектор=a|детайл=b` could alias the prompt/context boundary.
    const withPipe = buildDedupRequest({
      prompt: 'разходи за 2025',
      period: Y2025,
      periodSettling: false,
      filterContext: 'сектор=a|детайл=b',
      freshness: FRESH,
    });
    const withoutPipe = buildDedupRequest({
      prompt: 'разходи за 2025',
      period: Y2025,
      periodSettling: false,
      filterContext: 'сектор=a',
      freshness: FRESH,
    });
    expect(withPipe.doName).toContain('\\|'); // the free-text pipe was escaped, not left bare
    expect(withPipe.doName).not.toBe(withoutPipe.doName);
  });
});
