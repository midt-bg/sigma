import { describe, expect, it } from 'vitest';
import type { OverrunAnnex } from '@sigma/db';
import { contractStatus, groupAnnexes, STATUS_LABEL } from './overruns-inspector';

const NOW = new Date('2026-06-27T12:00:00Z');

describe('contractStatus', () => {
  it('returns „closed" when the term date is before today', () => {
    expect(contractStatus('2024-12-31', NOW)).toBe('closed');
    expect(STATUS_LABEL.closed).toBe('Приключен');
  });

  it('returns „active" when the term date is today or in the future', () => {
    expect(contractStatus('2026-06-27', NOW)).toBe('active'); // today is not yet past
    expect(contractStatus('2027-01-01', NOW)).toBe('active');
    expect(STATUS_LABEL.active).toBe('В изпълнение');
  });

  it('reads only the date prefix of a datetime', () => {
    expect(contractStatus('2024-01-15T08:30:00Z', NOW)).toBe('closed');
  });

  it('omits the badge (null) when there is no reliable date', () => {
    expect(contractStatus(null, NOW)).toBeNull();
    expect(contractStatus(undefined, NOW)).toBeNull();
    expect(contractStatus('', NOW)).toBeNull();
    expect(contractStatus('не е посочено', NOW)).toBeNull();
    expect(contractStatus('2024', NOW)).toBeNull(); // not a full YYYY-MM-DD
  });
});

describe('groupAnnexes', () => {
  const row = (over: Partial<OverrunAnnex> = {}): OverrunAnnex => ({
    contractId: 'c:1',
    date: '2023-01-01',
    reason: 'причина',
    valueBeforeEur: 100,
    valueAfterEur: 150,
    deltaEur: 50,
    ...over,
  });

  it('groups by contract and assigns a 1-based „Анекс N" sequence in order', () => {
    const grouped = groupAnnexes([
      row({ contractId: 'c:1', date: '2023-01-01' }),
      row({ contractId: 'c:1', date: '2023-06-01' }),
      row({ contractId: 'c:2', date: '2024-01-01' }),
    ]);

    expect(Object.keys(grouped)).toEqual(['c:1', 'c:2']);
    expect(grouped['c:1']!.map((a) => a.seq)).toEqual([1, 2]);
    expect(grouped['c:1']![1]!.date).toBe('2023-06-01');
    expect(grouped['c:2']!.map((a) => a.seq)).toEqual([1]);
  });

  it('carries the real delta and reason through, including nulls', () => {
    const grouped = groupAnnexes([row({ deltaEur: null, reason: null })]);

    expect(grouped['c:1']![0]!.deltaEur).toBeNull();
    expect(grouped['c:1']![0]!.reason).toBeNull();
  });

  it('returns an empty object for no rows', () => {
    expect(groupAnnexes([])).toEqual({});
  });
});
