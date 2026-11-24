import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterFlight, FOLLOWER_WAIT_MS } from './render-gate';

afterEach(() => vi.useRealTimers());

const signal = () => new AbortController().signal;

describe('single flight', () => {
  it('chooses one leader and gives all followers its failure status', async () => {
    const owner = enterFlight('error', signal());
    const first = enterFlight('error', signal());
    const second = enterFlight('error', signal());
    if (!owner || 'wait' in owner || !first || !('wait' in first) || !second || !('wait' in second))
      throw new Error('Wrong owner');

    owner.settle(503);
    expect(await Promise.all([first.wait, second.wait])).toEqual([503, 503]);
    const next = enterFlight('error', signal());
    if (!next || 'wait' in next) throw new Error('No later owner');
    next.settle('bypass');
  });

  it('keeps the owner after follower patience runs out', async () => {
    vi.useFakeTimers();
    const owner = enterFlight('slow-render', signal());
    const follower = enterFlight('slow-render', signal());
    if (!owner || 'wait' in owner || !follower || !('wait' in follower))
      throw new Error('Wrong owner');

    await vi.advanceTimersByTimeAsync(FOLLOWER_WAIT_MS);
    expect(await follower.wait).toBe('timeout');
    expect(follower.recover()).toBeNull();
    expect(owner.isCurrent()).toBe(true);
    owner.settle('put-complete');
  });

  it('allows only one overlapping origin attempt after consecutive disconnects', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const owner = enterFlight('disconnect', first.signal);
    const waiter = enterFlight('disconnect', second.signal);
    if (!owner || 'wait' in owner || !waiter || !('wait' in waiter)) throw new Error('Wrong owner');
    first.abort();
    expect(await waiter.wait).toBe('abandoned');

    const successor = waiter.recover();
    if (!successor || 'wait' in successor) throw new Error('No successor');
    expect(owner.isCurrent()).toBe(false);
    second.abort();
    expect(enterFlight('disconnect', signal())).toBeNull();
    owner.settle('bypass');
    const third = enterFlight('disconnect', signal());
    if (!third || 'wait' in third) throw new Error('No third owner after work settled');
    successor.settle('bypass');
    expect(third.isCurrent()).toBe(true);
    third.settle('bypass');
  });

  it('reopens the slot when disconnected attempts never settle', () => {
    vi.useFakeTimers();
    const key = 'disconnect-without-cleanup';
    const first = new AbortController();
    const second = new AbortController();
    const owner = enterFlight(key, first.signal);
    if (!owner || 'wait' in owner) throw new Error('No first owner');
    first.abort();
    const successor = enterFlight(key, second.signal);
    if (!successor || 'wait' in successor) throw new Error('No replacement owner');
    second.abort();

    // The invocations disappear without running finally. They stop holding the slot after 30 s.
    vi.advanceTimersByTime(29_999);
    expect(enterFlight(key, signal())).toBeNull();
    vi.advanceTimersByTime(1);
    const fresh = enterFlight(key, signal());
    if (!fresh || 'wait' in fresh) throw new Error('Slot did not reopen');
    owner.settle('put-complete');
    successor.settle('put-complete');
    expect(fresh.isCurrent()).toBe(true);
    fresh.settle('bypass');
  });
});
