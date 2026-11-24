// Signals cross request contexts. Responses, timers and Cache API I/O belong to each caller.
export const FOLLOWER_WAIT_MS = 10_000;
// A disconnected invocation can vanish without running finally. Allow one replacement while
// its origin work winds down, then keep that overlap allowance occupied for at most 30 seconds.
const ABANDONED_MS = 30_000;

export type FlightOutcome = 'put-complete' | 'bypass' | 'abandoned' | number;

type Flight = {
  listeners: Set<(outcome: FlightOutcome) => void>;
  outcome?: FlightOutcome;
  abandonedUntil?: number;
  put?: { takeoverAt: number; expires: number };
  recovery?: Flight;
};

type Slot = { current?: Flight; predecessor?: Flight };
const flights = new Map<string, Slot>();
let nextSweep = 0;

function prune(slot: Slot, now: number): void {
  const predecessorUntil = slot.predecessor?.abandonedUntil;
  if (predecessorUntil !== undefined && predecessorUntil <= now) delete slot.predecessor;
  const current = slot.current;
  if (!current) return;
  const expires = current.abandonedUntil ?? current.put?.expires;
  if (expires !== undefined && expires <= now) {
    delete slot.current;
    finish(current, 'abandoned');
  }
}

function sweep(now: number): void {
  if (now < nextSweep) return;
  nextSweep = now + FOLLOWER_WAIT_MS;
  for (const [key, slot] of flights) {
    prune(slot, now);
    if (!slot.current && !slot.predecessor) flights.delete(key);
  }
}

function finish(flight: Flight, outcome: FlightOutcome): void {
  if (flight.outcome !== undefined) return;
  flight.outcome = outcome;
  for (const notify of flight.listeners) notify(outcome);
  flight.listeners.clear();
}

async function waitFor(flight: Flight, signal: AbortSignal): Promise<FlightOutcome | 'timeout'> {
  if (flight.outcome !== undefined) return flight.outcome;

  let notify!: (outcome: FlightOutcome | 'timeout') => void;
  const result = new Promise<FlightOutcome | 'timeout'>((resolve) => (notify = resolve));
  const stopWaiting = () => {
    flight.listeners.delete(notify);
    notify('timeout');
  };
  const timer = setTimeout(stopWaiting, FOLLOWER_WAIT_MS);
  flight.listeners.add(notify);
  signal.addEventListener('abort', stopWaiting, { once: true });
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stopWaiting);
  }
}

export interface RenderOwner {
  isCurrent(): boolean;
  beginPut(expires: number): void;
  settle(outcome: FlightOutcome): void;
}

interface Follower {
  wait: Promise<FlightOutcome | 'timeout'>;
  recover(): RenderAdmission;
}

type RenderAdmission = RenderOwner | Follower | null;

function follow(key: string, flight: Flight, signal: AbortSignal): Follower {
  return {
    wait: waitFor(flight, signal),
    recover: () => admit(key, signal, flight),
  };
}

export function enterFlight(key: string, signal: AbortSignal): RenderAdmission {
  return admit(key, signal);
}

function admit(key: string, signal: AbortSignal, previous?: Flight): RenderAdmission {
  if (signal.aborted) return null;
  if (previous?.recovery) return follow(key, previous.recovery, signal);

  const now = Date.now();
  sweep(now);
  const slot = flights.get(key) ?? {};
  prune(slot, now);
  const current = slot.current;
  if (current) {
    if (current.abandonedUntil !== undefined) {
      if (slot.predecessor) return null;
      slot.predecessor = current;
    } else if (!current.put || now < current.put.takeoverAt) {
      // Follower patience does not invalidate a healthy render or start competing origin work.
      if (current === previous) return null;
      if (previous) previous.recovery = current;
      return follow(key, current, signal);
    }
  }

  const flight: Flight = { listeners: new Set() };
  slot.current = flight;
  flights.set(key, slot);
  if (previous) previous.recovery = flight;
  if (current) finish(current, 'abandoned');

  const abandon = () => {
    if (slot.current !== flight) return;
    flight.abandonedUntil = Date.now() + ABANDONED_MS;
    finish(flight, 'abandoned');
  };
  signal.addEventListener('abort', abandon, { once: true });

  return {
    isCurrent: () => slot.current === flight && flight.abandonedUntil === undefined,
    beginPut: (expires) => {
      // Origin work finished. A stuck waitUntil put can be superseded without a second D1 attempt
      // running alongside it. Its separate read fence still covers the outstanding write.
      signal.removeEventListener('abort', abandon);
      flight.put = { takeoverAt: Date.now() + FOLLOWER_WAIT_MS, expires };
    },
    settle: (outcome) => {
      signal.removeEventListener('abort', abandon);
      if (slot.current === flight) delete slot.current;
      if (slot.predecessor === flight) delete slot.predecessor;
      if (!slot.current && !slot.predecessor && flights.get(key) === slot) flights.delete(key);
      finish(flight, outcome);
    },
  };
}
