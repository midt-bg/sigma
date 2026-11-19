import { afterEach, describe, expect, it, vi } from 'vitest';
import { claim, FLIGHT_MS, inFlight } from './render-gate';

afterEach(() => vi.useRealTimers());

describe('the single flight of identical misses', () => {
  it('has the next identical miss wait for the render under way, and no other page', async () => {
    const settle = claim('page-a');
    const waiting = inFlight('page-a');
    expect(waiting).toBeInstanceOf(Promise);
    expect(inFlight('page-b')).toBeUndefined();
    settle();
    await waiting;
    expect(inFlight('page-a')).toBeUndefined();
  });

  it('keeps the render under way when the same page is claimed again', async () => {
    const settle = claim('page-c');
    const waiting = inFlight('page-c');
    claim('page-c')();
    expect(inFlight('page-c')).toBeInstanceOf(Promise);
    settle();
    await waiting;
    expect(inFlight('page-c')).toBeUndefined();
  });

  it('stops counting a render that ran out of time, whose late end leaves its successor alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const late = claim('page-d');
    vi.setSystemTime(Date.now() + FLIGHT_MS);
    expect(inFlight('page-d')).toBeUndefined();
    const settle = claim('page-d');
    late();
    expect(inFlight('page-d')).toBeInstanceOf(Promise);
    settle();
    expect(inFlight('page-d')).toBeUndefined();
  });
});
