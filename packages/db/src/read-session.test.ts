import { describe, expect, it, vi } from 'vitest';
import { getDb } from './readonly-d1';
import { inReadSession } from './read-session';

// A binding that records what reaches it and what reaches each session it opens.
function binding() {
  const opened: unknown[] = [];
  const session = {
    prepare: vi.fn(
      (query: string) => ({ query, via: 'session' }) as unknown as D1PreparedStatement,
    ),
    batch: vi.fn(async () => []),
  };
  const DB = {
    prepare: vi.fn(
      (query: string) => ({ query, via: 'binding' }) as unknown as D1PreparedStatement,
    ),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0)),
    withSession: vi.fn((constraint?: unknown) => {
      opened.push(constraint);
      return session;
    }),
  };
  return { DB: DB as unknown as D1Database, raw: DB, session, opened };
}

describe('the read session of a request', () => {
  it('prepares the request’s statements in one session that any copy of the database may answer', () => {
    const { DB, raw, session, opened } = binding();
    const env = inReadSession({ DB, OTHER: 'binding' });
    expect(opened).toEqual(['first-unconstrained']);
    expect(env.OTHER).toBe('binding');

    expect(env.DB.prepare('SELECT 1')).toMatchObject({ via: 'session' });
    expect(env.DB.prepare('SELECT 2')).toMatchObject({ via: 'session' });
    expect(session.prepare).toHaveBeenCalledTimes(2);
    expect(raw.prepare).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
  });

  it('opens a session per request, not per isolate', () => {
    const { DB, opened } = binding();
    const env = { DB };
    inReadSession(env);
    inReadSession(env);
    expect(opened).toHaveLength(2);
    // The worker's own env is never changed: the next request starts from the bare binding.
    expect(env.DB).toBe(DB);
  });

  it('leaves the rest of the binding where it was', async () => {
    const { DB, raw, session } = binding();
    const env = inReadSession({ DB });
    await env.DB.batch([]);
    await env.DB.exec('SELECT 1');
    await env.DB.dump();
    env.DB.withSession('first-primary');
    expect(session.batch).toHaveBeenCalledTimes(1);
    expect(raw.batch).not.toHaveBeenCalled();
    expect(raw.exec).toHaveBeenCalledWith('SELECT 1');
    expect(raw.dump).toHaveBeenCalledTimes(1);
    expect(raw.withSession).toHaveBeenLastCalledWith('first-primary');
  });

  it('leaves an env whose binding has no sessions, or no binding at all, as it is', () => {
    const plain = { DB: { prepare: () => null } as unknown as D1Database };
    expect(inReadSession(plain)).toBe(plain);
    const none: { DB?: D1Database } = {};
    expect(inReadSession(none)).toBe(none);
  });

  it('stays behind the read-only handle: a write is refused before it reaches the session', () => {
    const { DB, session } = binding();
    const db = getDb(inReadSession({ DB }));
    db.prepare('SELECT 1');
    expect(session.prepare).toHaveBeenCalledWith('SELECT 1');
    expect(() => db.prepare('DELETE FROM contracts')).toThrow();
    expect(session.prepare).toHaveBeenCalledTimes(1);
    expect(() => db.withSession('first-primary')).toThrow(/not available/);
  });
});
