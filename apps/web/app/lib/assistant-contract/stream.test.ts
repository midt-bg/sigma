import { describe, expect, it } from 'vitest';
import { INSUFFICIENT_DATA_MESSAGE, isPhasePart, REPORT_FAILED_MESSAGE } from './stream';

describe('isPhasePart', () => {
  it('accepts each of the three valid phase keys', () => {
    expect(isPhasePart({ type: 'data-phase', data: { phase: 'thinking' } })).toBe(true);
    expect(isPhasePart({ type: 'data-phase', data: { phase: 'querying' } })).toBe(true);
    expect(isPhasePart({ type: 'data-phase', data: { phase: 'composing' } })).toBe(true);
  });

  it('rejects a part whose type is not data-phase', () => {
    expect(isPhasePart({ type: 'data-report-ready', data: { phase: 'thinking' } })).toBe(false);
  });

  it('rejects a phase part with no data', () => {
    expect(isPhasePart({ type: 'data-phase' })).toBe(false);
  });

  it('rejects an unknown phase key', () => {
    expect(isPhasePart({ type: 'data-phase', data: { phase: 'running' } })).toBe(false);
  });

  it('rejects a non-string phase', () => {
    expect(isPhasePart({ type: 'data-phase', data: { phase: 2 } })).toBe(false);
  });
});

describe('user-facing failure messages', () => {
  it('keeps the technical compose-failure message distinct from the insufficient-data one', () => {
    // A thrown/rejected emit_report means the report FAILED — the data may well exist. Labeling it
    // "insufficient data" asserts a wrong cause (PR #51 review), so the two can never re-unify.
    expect(REPORT_FAILED_MESSAGE).toBe('Справката не можа да бъде съставена. Опитайте отново.');
    expect(REPORT_FAILED_MESSAGE).not.toContain(INSUFFICIENT_DATA_MESSAGE);
    expect(INSUFFICIENT_DATA_MESSAGE).not.toContain(REPORT_FAILED_MESSAGE);
  });
});
