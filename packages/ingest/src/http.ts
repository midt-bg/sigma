// Shared fetch hygiene for every Worker-side reader in this package and in apps/etl.

/**
 * Release a response body we are never going to read.
 *
 * In the Workers runtime a body that is neither consumed nor cancelled keeps its stream - and the
 * connection behind it - open for the rest of the invocation; the collector is not a substitute.
 * Every path that walks away from a response (a blocked redirect, a missing object, any non-OK
 * status) has to release it explicitly.
 *
 * Deliberately NOT awaited. Cancelling only needs to be *initiated* for the runtime to release the
 * stream, and awaiting it would make the caller hostage to a `cancel()` that never settles - the
 * exact failure mode this is meant to reduce, not add to.
 */
export function discardBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {
      // Already consumed, locked, or errored - there is nothing left to release either way.
    });
  } catch {
    // `cancel()` itself threw synchronously (locked body). Same conclusion.
  }
}
