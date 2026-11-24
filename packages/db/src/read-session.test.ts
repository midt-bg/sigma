import { recordingD1 } from '@sigma/test-support';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from './readonly-d1';
import { inReadSession } from './read-session';

// Exercise the adapter with separate statement logs for the bare binding and its sessions.
function binding() {
  const raw = recordingD1();
  const reader = recordingD1();
  const session: D1DatabaseSession = {
    prepare: reader.db.prepare.bind(reader.db),
    batch: reader.db.batch.bind(reader.db),
    getBookmark: () => null,
  };
  const DB = Object.assign(raw.db, {
    dump: vi.fn(async () => new ArrayBuffer(0)),
    withSession: vi.fn((_constraint?: D1SessionConstraint | D1SessionBookmark) => session),
  });
  return { DB, raw, reader };
}

describe('the read session of a request', () => {
  it('prepares the request’s statements in one session that any copy of the database may answer', () => {
    const { DB, raw, reader } = binding();
    const env = inReadSession({ DB, OTHER: 'binding' });
    expect(DB.withSession).toHaveBeenCalledExactlyOnceWith('first-unconstrained');
    expect(env.OTHER).toBe('binding');

    env.DB.prepare('SELECT 1');
    env.DB.prepare('SELECT 2');
    expect(reader.sql).toEqual(['SELECT 1', 'SELECT 2']);
    expect(raw.calls).toEqual([]);
    expect(DB.withSession).toHaveBeenCalledTimes(1);
  });

  it('opens a session per request, not per isolate', () => {
    const { DB } = binding();
    const env = { DB };
    inReadSession(env);
    inReadSession(env);
    expect(DB.withSession).toHaveBeenCalledTimes(2);
    // The worker's own env is never changed: the next request starts from the bare binding.
    expect(env.DB).toBe(DB);
  });

  it('leaves the rest of the binding where it was', async () => {
    const { DB, raw, reader } = binding();
    const env = inReadSession({ DB });
    await env.DB.batch([env.DB.prepare('SELECT 2')]);
    await env.DB.exec('SELECT 1');
    await env.DB.dump();
    env.DB.withSession('first-primary');
    expect(reader.calls).toEqual([
      { sql: 'SELECT 2', via: 'prepare', binds: [] },
      { sql: 'SELECT 2', via: 'batch', binds: [] },
    ]);
    expect(raw.calls).toEqual([{ sql: 'SELECT 1', via: 'exec', binds: [] }]);
    expect(DB.dump).toHaveBeenCalledTimes(1);
    expect(DB.withSession).toHaveBeenLastCalledWith('first-primary');
  });

  it('leaves an env whose binding has no sessions, or no binding at all, as it is', () => {
    const plain = { DB: recordingD1().db };
    expect(inReadSession(plain)).toBe(plain);
    const none: { DB?: D1Database } = {};
    expect(inReadSession(none)).toBe(none);
  });

  it('stays behind the read-only handle: a write is refused before it reaches the session', () => {
    const { DB, reader } = binding();
    const db = getDb(inReadSession({ DB }));
    db.prepare('SELECT 1');
    expect(() => db.prepare('DELETE FROM contracts')).toThrow();
    expect(reader.sql).toEqual(['SELECT 1']);
    expect(() => db.withSession('first-primary')).toThrow(/not available/);
  });
});
