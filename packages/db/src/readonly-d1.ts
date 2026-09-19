import { assertReadOnly, assertReadOnlyExec } from './readonly-sql';
import { retryingStatement } from './retrying-d1';

// A read-only view over a D1Database for the web runtime (issue #199). Cloudflare has no read-only D1
// binding, so env.DB is read+write; this gates the two SQL entry points (.prepare, .exec) on the
// read-only predicate, and throws on the three methods web never uses: .batch takes opaque prepared
// statements it cannot re-inspect, .withSession returns an unguarded handle, and .dump exfils the whole
// DB. SQL is fixed at .prepare() time and .bind() only supplies values, so gating .prepare/.exec closes
// every write entry point. Only web goes through here; the ETL worker keeps the raw binding.
//
// Being the one handle web reads through, it is also where a transient D1 fault is retried, so no route
// can forget to (retrying-d1.ts). That costs one small wrapper object per .prepare() — nothing beside a
// D1 round trip, and the reason the statement is no longer handed back untouched.
class ReadonlyD1 implements D1Database {
  constructor(private readonly db: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    assertReadOnly(query);
    // Every statement past the guard is a SELECT, which is what makes a blind retry provably safe here
    // — see retrying-d1.ts. A new route therefore cannot forget it the way loader-level retries were
    // forgotten on most pages.
    return retryingStatement(this.db.prepare(query));
  }

  exec(query: string): Promise<D1ExecResult> {
    assertReadOnlyExec(query);
    return this.db.exec(query);
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    throw new Error('@sigma/db: batch() is not available on the read-only D1 handle');
  }

  // Note: this forecloses the D1 Sessions API, i.e. read-replica routing — a deliberate least-privilege
  // tradeoff for now (web is not replica-scaled). If read-heavy scaling later needs replicas, route reads
  // through a guarded session handle here rather than dropping the wrapper.
  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    throw new Error('@sigma/db: withSession() is not available on the read-only D1 handle');
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('@sigma/db: dump() is not available on the read-only D1 handle');
  }
}

/**
 * Wrap a D1Database so the web runtime can only read: `.prepare()`/`.exec()` reject any non-SELECT,
 * `.batch()`/`.withSession()`/`.dump()` throw. Defense-in-depth least-privilege for #199 — the assistant
 * `run_sql` AST guard is no longer the only barrier between the model and a D1 write.
 */
export function readonlyD1(db: D1Database): D1Database {
  return new ReadonlyD1(db);
}

/**
 * The web worker's single read-only D1 chokepoint (#199): wrap the write-capable `env.DB` so web reads
 * D1 only through here, never the raw binding. The ETL worker keeps the raw binding. Pure (no cache) to
 * keep @sigma/db stateless — wrapping is one cheap allocation.
 */
export function getDb(env: { DB: D1Database }): D1Database {
  return readonlyD1(env.DB);
}
