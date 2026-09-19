// Transient-fault retry for the web runtime's D1 reads.
//
// D1, like any networked store, occasionally throws a blip — a dropped connection, a momentary internal
// error, a brief timeout — and it is far likelier while a bulk job is writing to the same database. One
// such blip on any single query rejected the whole loader and rendered the full-page error boundary. A
// crawl of 220 pages during a weekly declarations run hit it twice, on two pages whose loaders had no
// retry of their own.
//
// It lives HERE rather than in each loader because the retry must never be something a new route can
// forget: `readonlyD1` is the single handle web reads D1 through. It is also only safe here — every
// statement this wrapper can see has already passed `assertReadOnly`, so re-running one has no side
// effect whatsoever. A loader-level wrapper has to argue that case per call site; this one cannot be
// wrong about it.

const BACKOFF_MS = [50, 150];

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (const [i, backoff] of BACKOFF_MS.entries()) {
    try {
      return await run();
    } catch (error) {
      // A thrown Response is React Router's 404/redirect idiom, never a transient fault. Nothing below
      // D1 throws one, but re-throwing keeps that true if a future caller passes one through.
      if (error instanceof Response) throw error;
      console.warn(
        `[retryingD1] read failed (attempt ${i + 1}/${BACKOFF_MS.length + 1}), retrying:`,
        error instanceof Error ? error.message : error,
      );
      await delay(backoff);
    }
  }
  // The last attempt is deliberately outside the loop: its error is the one the caller must see.
  return await run();
}

/** A prepared SELECT whose result methods survive a transient fault. `bind()` keeps the wrapper, so it
 *  makes no difference whether a caller binds before reading. */
class RetryingStatement implements D1PreparedStatement {
  constructor(private readonly stmt: D1PreparedStatement) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new RetryingStatement(this.stmt.bind(...values));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T>(colName?: string): Promise<T | null> {
    return withRetry(() =>
      colName === undefined
        ? (this.stmt.first<T>() as Promise<T | null>)
        : (this.stmt.first<T>(colName) as Promise<T | null>),
    );
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return withRetry(() => this.stmt.run<T>());
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return withRetry(() => this.stmt.all<T>());
  }

  // Nothing in web reads through .raw() today; it is here because the interface has it, and it retries
  // like the rest so that stays true if something starts to. The options object is forwarded as given —
  // the cast satisfies both overloads at once, it does not change what is passed.
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T>(options?: { columnNames?: boolean }) {
    return withRetry(() => this.stmt.raw<T>(options as { columnNames: true })) as Promise<
      [string[], ...T[]]
    > &
      Promise<T[]>;
  }
}

export function retryingStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  return new RetryingStatement(stmt);
}
