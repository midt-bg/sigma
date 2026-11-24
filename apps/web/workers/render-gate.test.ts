import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterFlight, FLIGHT_MS, trackWrite, writePending } from './render-gate';

afterEach(() => vi.useRealTimers());

describe('single flight', () => {
  it('chooses one leader and gives every follower its failure status', async () => {
    const owner = enterFlight('error');
    const first = enterFlight('error');
    const second = enterFlight('error');
    expect(owner).toHaveProperty('settle');
    expect(first).toHaveProperty('wait');
    expect(second).toHaveProperty('wait');
    if ('wait' in owner || !('wait' in first) || !('wait' in second))
      throw new Error('Wrong owner');

    owner.settle(503);
    expect(await Promise.all([first.wait, second.wait])).toEqual([503, 503]);
    const next = enterFlight('error');
    expect(next).toHaveProperty('settle');
    if ('settle' in next) next.settle('bypass');
  });

  it('lets one requester take over after a deadline and fences the previous owner', async () => {
    vi.useFakeTimers();
    const owner = enterFlight('abandoned');
    const waiter = enterFlight('abandoned');
    if ('wait' in owner || !('wait' in waiter)) throw new Error('Wrong owner');
    await vi.advanceTimersByTimeAsync(FLIGHT_MS);
    expect(await waiter.wait).toBe('timeout');

    const next = enterFlight('abandoned');
    if ('wait' in next) throw new Error('No successor');
    expect(owner.isCurrent()).toBe(false);
    owner.settle('stored');
    expect(next.isCurrent()).toBe(true);
    next.settle('bypass');
  });

  it('holds the read fence for an issued put only while its entry could still be fresh', () => {
    vi.useFakeTimers();
    const expires = Date.now() + 1000;
    const release = trackWrite('cache-write', expires);
    expect(writePending('cache-write')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(writePending('cache-write')).toBe(false);

    const releaseNext = trackWrite('cache-write', expires + 1000);
    release();
    expect(writePending('cache-write')).toBe(true);
    releaseNext();
    expect(writePending('cache-write')).toBe(false);
  });
});
