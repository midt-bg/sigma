// Per-isolate guard in front of the loaders (and so D1) for edge-cache misses:
//   • single-flight — identical misses wait for the first one's cache entry instead of each reading D1;
//   • a cap on renders under way, past which a request is shed with a 503 instead of queueing behind D1.
// ponytail: per isolate only. Cloudflare runs many isolates per colo, so this tames one herd on one isolate,
// not the whole site; coalescing across isolates would need a Durable Object.

// How many renders one isolate runs at once before it sheds. A knob: raise it if 503s show up at load D1
// still has room for.
export const MAX_RENDERING = 20;

const flights = new Map<string, Promise<void>>();
let rendering = 0;

/** The identical miss already rendering in this isolate, settled once its cache entry is stored (or not). */
export function inFlight(key: string): Promise<void> | undefined {
  return flights.get(key);
}

/** Become the render the next identical misses wait for; call the returned function when done. */
export function claim(key: string): () => void {
  if (flights.has(key)) return () => {};
  let settle!: () => void;
  flights.set(key, new Promise<void>((resolve) => (settle = resolve)));
  return () => {
    flights.delete(key);
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
