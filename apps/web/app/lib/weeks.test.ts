import { describe, expect, it } from 'vitest';
import { isValidIsoWeek, isoWeekKey, listStoredWeeks, weekRangeLabel } from './weeks';

// A single-page R2 list stub (no pagination): `list` returns these objects, not truncated.
function bucketListing(
  objects: { key: string; customMetadata?: Record<string, string> }[],
): R2Bucket {
  return {
    list: async () => ({ objects, truncated: false }),
  } as unknown as R2Bucket;
}

describe('isoWeekKey / isValidIsoWeek', () => {
  it('builds the deterministic artifact key', () => {
    expect(isoWeekKey('2026-W25')).toBe('weeks/2026-W25.json');
  });

  it('accepts a well-formed ISO week and rejects anything else', () => {
    expect(isValidIsoWeek('2026-W01')).toBe(true);
    expect(isValidIsoWeek('2026-W25')).toBe(true);
    expect(isValidIsoWeek('2026-25')).toBe(false);
    expect(isValidIsoWeek('not-a-week')).toBe(false);
    expect(isValidIsoWeek('../weeks/x')).toBe(false);
  });

  it('accepts W53 but rejects the impossible week numbers W00 and W54–99', () => {
    expect(isValidIsoWeek('2020-W53')).toBe(true); // 2020 is a 53-week ISO year
    expect(isValidIsoWeek('2026-W00')).toBe(false);
    expect(isValidIsoWeek('2026-W54')).toBe(false);
    expect(isValidIsoWeek('2026-W99')).toBe(false);
  });
});

describe('listStoredWeeks', () => {
  it('returns the partial accumulated list (not an error) when R2 list() fails mid-pagination', async () => {
    // First page ok + truncated; the second list() call throws. The archive must degrade to the weeks
    // gathered so far rather than 500.
    let call = 0;
    const flakyBucket = {
      list: async () => {
        call += 1;
        if (call === 1) {
          return {
            objects: [{ key: 'weeks/2026-W25.json', customMetadata: { totalEur: '2000' } }],
            truncated: true,
            cursor: 'c1',
          };
        }
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;

    const weeks = await listStoredWeeks(flakyBucket);
    expect(weeks.map((w) => w.iso)).toEqual(['2026-W25']);
    expect(weeks[0]!.totalEur).toBe(2000);
  });

  it('lists weeks newest-first with totals parsed from customMetadata', async () => {
    const weeks = await listStoredWeeks(
      bucketListing([
        { key: 'weeks/2026-W24.json', customMetadata: { totalEur: '1000' } },
        { key: 'weeks/2026-W26.json', customMetadata: { totalEur: '3000' } },
        { key: 'weeks/2026-W25.json', customMetadata: { totalEur: '2000' } },
      ]),
    );
    expect(weeks.map((w) => w.iso)).toEqual(['2026-W26', '2026-W25', '2026-W24']);
    expect(weeks[0].totalEur).toBe(3000);
  });

  it('ignores objects whose key is not a weekly-digest artifact', async () => {
    const weeks = await listStoredWeeks(
      bucketListing([
        { key: 'weeks/2026-W25.json', customMetadata: { totalEur: '2000' } },
        { key: 'weeks/README.txt' },
        { key: 'report/r_abc.json' },
      ]),
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0].iso).toBe('2026-W25');
  });

  it('yields a null total when metadata is missing or malformed', async () => {
    const weeks = await listStoredWeeks(
      bucketListing([
        { key: 'weeks/2026-W25.json' },
        { key: 'weeks/2026-W24.json', customMetadata: { totalEur: 'NaN' } },
      ]),
    );
    expect(weeks.every((w) => w.totalEur === null)).toBe(true);
  });

  it('parses Mon–Sun dates from customMetadata, null when absent or malformed', async () => {
    const weeks = await listStoredWeeks(
      bucketListing([
        {
          key: 'weeks/2026-W25.json',
          customMetadata: { monday: '2026-06-15', sunday: '2026-06-21', totalEur: '2000' },
        },
        { key: 'weeks/2026-W24.json', customMetadata: { totalEur: '1000' } }, // no dates → null
        {
          key: 'weeks/2026-W23.json',
          customMetadata: { monday: 'garbage', sunday: '2026-06-07' }, // malformed monday → null
        },
      ]),
    );
    const byIso = Object.fromEntries(weeks.map((w) => [w.iso, w]));
    expect(byIso['2026-W25']).toMatchObject({ monday: '2026-06-15', sunday: '2026-06-21' });
    expect(byIso['2026-W24']).toMatchObject({ monday: null, sunday: null });
    expect(byIso['2026-W23']).toMatchObject({ monday: null, sunday: '2026-06-07' });
  });
});

describe('weekRangeLabel', () => {
  it('formats the Mon–Sun range as DD.MM.YYYY – DD.MM.YYYY when both dates are present', () => {
    expect(weekRangeLabel({ iso: '2026-W29', monday: '2026-07-13', sunday: '2026-07-19' })).toBe(
      '13.07.2026 – 19.07.2026',
    );
  });

  it('falls back to the iso when either date is missing', () => {
    expect(weekRangeLabel({ iso: '2026-W29', monday: null, sunday: '2026-07-19' })).toBe(
      '2026-W29',
    );
    expect(weekRangeLabel({ iso: '2026-W29', monday: '2026-07-13', sunday: null })).toBe(
      '2026-W29',
    );
    expect(weekRangeLabel({ iso: '2026-W29', monday: null, sunday: null })).toBe('2026-W29');
  });
});
