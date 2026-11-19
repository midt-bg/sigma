// One D1 session per web request, so the request's reads may be answered by a read replica.
//
// D1 runs a query on a replica only when it arrives through the Sessions API; a query on the bare binding
// always goes to the primary, however many replicas the database has. A session opened as
// „first-unconstrained" lets its first query be answered by whichever copy is nearest, and promises every
// later query of the session a copy at least as new as the one that answered before it: the loaders of
// one page never read backwards in time, whichever copies answer them.
//
// The web runtime only reads, so it has no write of its own to wait for; a replica is behind the primary
// by the time replication takes, and the pages rendered from it are stored at the edge for far longer
// than that. With replication off the session is served by the primary alone, as the bare binding was —
// the database setting, not this code, decides whether replicas answer.

/** The binding, with its statements prepared in one session. Everything else is the binding's own. */
class SessionD1 implements D1Database {
  constructor(
    private readonly db: D1Database,
    private readonly session: D1DatabaseSession,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return this.session.prepare(query);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.session.batch<T>(statements);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.db.exec(query);
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return this.db.withSession(constraintOrBookmark);
  }

  dump(): Promise<ArrayBuffer> {
    return this.db.dump();
  }
}

/**
 * The env of one request: the same bindings, with `DB` reading through a session of its own. Call it once
 * per request and hand the result to everything that reads for that request. A binding without sessions —
 * a test double, an older local runtime — is left as it is.
 */
export function inReadSession<E extends { DB?: D1Database }>(env: E): E {
  const db = env.DB;
  if (typeof db?.withSession !== 'function') return env;
  return { ...env, DB: new SessionD1(db, db.withSession('first-unconstrained')) };
}
