// Read-only loaders fan out several D1 queries per request (an entity detail page issues ~8, each
// `listContracts` a couple more). D1, like any networked store, occasionally throws a transient
// fault — a dropped connection, a momentary internal error, a brief timeout. Without a retry, one
// such blip on any single query rejects the whole loader and renders the full-page error boundary
// („Грешка"), even though an immediate re-read would have succeeded. This wraps a loader's data
// fetch in a bounded retry so a transient fault self-heals into a normal response instead of a 500.
//
// Safe only because these loaders are read-only and idempotent — re-running them has no side
// effects. Thrown `Response`s (404 / redirect) are intentional control flow, never transient, so
// they pass straight through without consuming a retry.

const BACKOFF_MS = [50, 150];

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run an idempotent, read-only data fetch, retrying on transient faults. A thrown `Response` (the
 * React Router idiom for 404/redirect) is re-thrown immediately. Any other error is retried up to
 * `attempts` times total with a short backoff; the last error propagates if every attempt fails.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  // Clamp so a caller passing attempts <= 0 still runs once and never `throw undefined`.
  const total = Math.max(1, attempts);
  let lastError: unknown;
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      // 404 / redirect — intentional, not a fault. Never retry; surface it on the first throw.
      if (error instanceof Response) throw error;
      lastError = error;
      if (attempt < total - 1) {
        // Logged so the otherwise-silent transient faults are visible in Workers logs.
        console.warn(
          `[withDbRetry] read failed (attempt ${attempt + 1}/${total}), retrying:`,
          error instanceof Error ? error.message : error,
        );
        await delay(BACKOFF_MS[attempt] ?? 150);
      }
    }
  }
  throw lastError;
}
