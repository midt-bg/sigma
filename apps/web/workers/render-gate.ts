// Per-isolate single flight. Only signals cross request contexts. Bodies and Cache API I/O stay
// in their owning requests. The deadline lets a later request replace an abandoned render.
export const FLIGHT_MS = 10_000;
export type FlightOutcome = 'stored' | 'bypass' | number;

type Flight = { done: Promise<FlightOutcome>; deadline: number };
const flights = new Map<string, Flight>();
const writes = new Map<string, { expires: number }>();
let nextSweep = 0;

function sweep(now: number): void {
  if (now < nextSweep) return;
  nextSweep = now + FLIGHT_MS;
  for (const [key, flight] of flights) {
    if (flight.deadline <= now) flights.delete(key);
  }
  for (const [key, write] of writes) {
    if (write.expires <= now) writes.delete(key);
  }
}

async function waitFor(flight: Flight, ms: number): Promise<FlightOutcome | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([flight.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RenderOwner {
  isCurrent(): boolean;
  settle(outcome: FlightOutcome): void;
}

export function enterFlight(
  key: string,
): RenderOwner | { wait: Promise<FlightOutcome | 'timeout'> } {
  const now = Date.now();
  sweep(now);
  const current = flights.get(key);
  if (current && now < current.deadline) {
    return { wait: waitFor(current, current.deadline - now) };
  }
  let resolve!: (outcome: FlightOutcome) => void;
  const done = new Promise<FlightOutcome>((settle) => (resolve = settle));
  const flight = { done, deadline: now + FLIGHT_MS };
  flights.set(key, flight);
  return {
    isCurrent: () => flights.get(key) === flight && Date.now() < flight.deadline,
    settle: (outcome) => {
      if (flights.get(key) === flight) flights.delete(key);
      resolve(outcome);
    },
  };
}

// A Cache API put already issued cannot be canceled. Until it settles and any late write is
// deleted, this isolate reads the origin and skips puts for this key. If the put never settles,
// the old entry's absolute freshness limit lets us forget the fence safely.
export function writePending(key: string): boolean {
  const write = writes.get(key);
  return write !== undefined && Date.now() < write.expires;
}

export function trackWrite(key: string, expires: number): () => void {
  const write = { expires };
  writes.set(key, write);
  return () => {
    if (writes.get(key) === write) writes.delete(key);
  };
}
