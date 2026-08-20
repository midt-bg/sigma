// ISO-week util for the weekly digest producer (#167A). Monday-anchored, ISO-8601 week numbering
// (`YYYY-Www`), distinct from `temporal.ts`'s question-parsing half-open date-only bounds.

import { describe, expect, it } from 'vitest';
import { isoWeekFromId, priorIsoWeek } from './iso-week';

describe('priorIsoWeek', () => {
  it('resolves the prior Mon–Sun week for a plain mid-week Wednesday', () => {
    // 2026-07-15 is a Wednesday. This week's Monday is 2026-07-13. Prior week: 2026-07-06..12.
    const result = priorIsoWeek(new Date('2026-07-15T12:00:00Z'));
    expect(result).toEqual({
      iso: '2026-W28',
      mondayIso: '2026-07-06',
      sundayIso: '2026-07-12',
      startTs: '2026-07-06T00:00:00',
      endTs: '2026-07-12T23:59:59',
    });
  });

  it('resolves a Monday-anchored `now` to the FULL prior week, not the current one', () => {
    // 2026-07-13 is a Monday (start of the current week) — the prior week must still be 07-06..12.
    const result = priorIsoWeek(new Date('2026-07-13T00:00:00Z'));
    expect(result.mondayIso).toBe('2026-07-06');
    expect(result.sundayIso).toBe('2026-07-12');
    expect(result.iso).toBe('2026-W28');
  });

  it('handles the W52/W53 → W01 year boundary (2020 had an ISO W53)', () => {
    // 2021-01-04 is a Monday — the prior week is 2020-12-28..2021-01-03, ISO week 2020-W53.
    const result = priorIsoWeek(new Date('2021-01-04T09:00:00Z'));
    expect(result).toEqual({
      iso: '2020-W53',
      mondayIso: '2020-12-28',
      sundayIso: '2021-01-03',
      startTs: '2020-12-28T00:00:00',
      endTs: '2021-01-03T23:59:59',
    });
  });

  it('handles a plain W52 → W01 year boundary (2025/2026, no W53)', () => {
    // 2026-01-05 is a Monday — the prior week is 2025-12-29..2026-01-04, ISO week 2026-W01 (that
    // week's Thursday, 2026-01-01, falls in ISO year 2026).
    const result = priorIsoWeek(new Date('2026-01-05T00:00:00Z'));
    expect(result).toEqual({
      iso: '2026-W01',
      mondayIso: '2025-12-29',
      sundayIso: '2026-01-04',
      startTs: '2025-12-29T00:00:00',
      endTs: '2026-01-04T23:59:59',
    });
  });

  it('resolves W01 for a January Monday whose prior week is fully in the old ISO year', () => {
    // 2027-01-11 is a Monday — the prior week 2027-01-04..10 stays in ISO year 2027, week 01.
    const result = priorIsoWeek(new Date('2027-01-11T00:00:00Z'));
    expect(result.iso).toBe('2027-W01');
    expect(result.mondayIso).toBe('2027-01-04');
    expect(result.sundayIso).toBe('2027-01-10');
  });
});

describe('isoWeekFromId', () => {
  it('resolves a mid-year week id to its full Mon–Sun record', () => {
    expect(isoWeekFromId('2026-W28')).toEqual({
      iso: '2026-W28',
      mondayIso: '2026-07-06',
      sundayIso: '2026-07-12',
      startTs: '2026-07-06T00:00:00',
      endTs: '2026-07-12T23:59:59',
    });
  });

  it('resolves a W53 leap week (ISO year 2020 has 53 weeks)', () => {
    expect(isoWeekFromId('2020-W53')).toEqual({
      iso: '2020-W53',
      mondayIso: '2020-12-28',
      sundayIso: '2021-01-03',
      startTs: '2020-12-28T00:00:00',
      endTs: '2021-01-03T23:59:59',
    });
  });

  it('resolves a W01 that starts in the prior calendar year', () => {
    expect(isoWeekFromId('2026-W01').mondayIso).toBe('2025-12-29');
  });

  it('round-trips against priorIsoWeek', () => {
    const wk = priorIsoWeek(new Date('2026-07-20T00:00:00Z'));
    expect(isoWeekFromId(wk.iso)).toEqual(wk);
  });

  it('throws on a malformed id', () => {
    expect(() => isoWeekFromId('2026W28')).toThrow(/not an ISO week id/);
    expect(() => isoWeekFromId('nope')).toThrow(/not an ISO week id/);
  });

  it('throws on an out-of-range week', () => {
    expect(() => isoWeekFromId('2026-W54')).toThrow(/not a valid ISO week/); // W54 never exists
    expect(() => isoWeekFromId('2027-W53')).toThrow(/not a valid ISO week/); // 2027 is a 52-week ISO year
    // (2026 IS a 53-week ISO year — Jan 1 2026 is a Thursday — so 2026-W53 is valid and must NOT throw.)
    expect(isoWeekFromId('2026-W53').iso).toBe('2026-W53');
  });
});
