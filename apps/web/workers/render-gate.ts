// Per-isolate guard in front of the loaders (and so D1) for edge-cache misses:
//   • single-flight — identical misses wait for the first one's cache entry instead of each reading D1;
//   • a cap on renders under way, past which a request is shed with a 503 instead of queueing behind D1.
// ponytail: per isolate only. Cloudflare runs many isolates per colo, so this tames one herd on one isolate,
// not the whole site; coalescing across isolates would need a Durable Object.

// How many renders one isolate runs at once before it sheds. A knob: raise it if 503s show up at load D1
// still has room for.
export const MAX_RENDERING = 20;

// How long an identical miss waits for the first render before it renders itself. The first render settles
// when its cache entry is stored, and a put whose request was cancelled (the visitor left) may never
// settle: without a bound, every later miss of that page on the isolate waited until its visitor gave up.
export const FLIGHT_MS = 10_000;

const flights = new Map<string, { done: Promise<void>; at: number }>();
let rendering = 0;

/**
 * The identical miss already rendering in this isolate: settles once its cache entry is stored (or not),
 * or when the flight runs out of time, whichever comes first.
 */
export function inFlight(key: string): Promise<void> | undefined {
  const flight = flights.get(key);
  const left = flight ? flight.at + FLIGHT_MS - Date.now() : 0;
  if (!flight || left <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, left)));
  return Promise.race([flight.done, timeout]).finally(() => clearTimeout(timer));
}

/** Become the render the next identical misses wait for; call the returned function when done. */
export function claim(key: string): () => void {
  const current = flights.get(key);
  if (current && Date.now() - current.at < FLIGHT_MS) return () => {};
  let settle!: () => void;
  const flight = { done: new Promise<void>((resolve) => (settle = resolve)), at: Date.now() };
  flights.set(key, flight);
  return () => {
    // A late settle of a timed-out flight must not drop the one that replaced it.
    if (flights.get(key) === flight) flights.delete(key);
    settle();
  };
}

/** Run a render within the cap; `null` when the isolate is already at it. */
export async function withinCap<T>(render: () => Promise<T>): Promise<T | null> {
  if (rendering >= MAX_RENDERING) return null;
  rendering += 1;
  try {
    return await render();
  } finally {
    rendering -= 1;
  }
}
