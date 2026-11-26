import { describe, expect, it, vi } from 'vitest';
import { readScheduledPause, SCHEDULED_PAUSE_KEY } from './pause';

const NOW = new Date('2026-11-26T10:00:00.000Z');
const bucket = (body: string | null) =>
  ({
    get: vi.fn(async (key: string) =>
      key === SCHEDULED_PAUSE_KEY && body !== null ? { text: async () => body } : null,
    ),
  }) as unknown as R2Bucket;

describe('readScheduledPause', () => {
  it('holds until its expiry, and no longer', async () => {
    const hold = { until: '2026-11-26T12:00:00.000Z', reason: 'slot switch' };
    expect(await readScheduledPause(bucket(JSON.stringify(hold)), NOW)).toEqual({ pause: hold });
    expect(
      await readScheduledPause(bucket(JSON.stringify(hold)), new Date('2026-11-26T12:00:00.000Z')),
    ).toEqual({ pause: null });
  });

  it('is no hold without a bucket or without the object', async () => {
    expect(await readScheduledPause(undefined, NOW)).toEqual({ pause: null });
    expect(await readScheduledPause(bucket(null), NOW)).toEqual({ pause: null });
  });

  it('names an object it cannot take as a hold, and does not hold', async () => {
    for (const body of [
      'not json',
      'null',
      JSON.stringify({ reason: 'no expiry' }),
      JSON.stringify({ until: 'next week', reason: 'unreadable expiry' }),
      JSON.stringify({ until: '2026-11-27T00:00:00Z' }),
      // A number parses as a year, so it would read as a date far ahead: only an ISO string is an expiry.
      JSON.stringify({ until: 4102444800000, reason: 'a number' }),
    ])
      expect(await readScheduledPause(bucket(body), NOW), body).toEqual({
        pause: null,
        problem: expect.any(String),
      });
  });

  it('does not hold when the bucket does not answer', async () => {
    const failing = {
      get: async () => {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;
    expect(await readScheduledPause(failing, NOW)).toEqual({
      pause: null,
      problem: 'unreadable: Error: R2 unavailable',
    });
  });
});
