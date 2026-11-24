// A request may opt into an unconstrained D1 session for replica-eligible reads. A bare D1 binding
// sends its queries to the primary. D1 sessions provide sequential consistency, not a snapshot.

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
