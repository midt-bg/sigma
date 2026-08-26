import { describe, expect, it } from 'vitest';
import { fakeD1, recordingD1, throwingD1, type FakeD1Call } from './fake-d1';

const ROWS = [{ id: 'c:1' }, { id: 'c:2' }];

/** The rejection of `promise`, or a failure if it resolved — so an assertion on the message of a
 *  query that quietly stopped throwing cannot pass by inspecting `undefined`. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the query to reject, but it resolved');
}

describe('fakeD1 — an unmatched query throws', () => {
  // The reason this helper exists (#325). A hand-rolled double returned { results: [] } for a query
  // it did not recognise, so renaming a CTE left the test green against emptiness. Emptiness must be
  // something a test asks for, never something it inherits.
  it('rejects a query no route matches', async () => {
    const { db } = fakeD1([{ when: 'FROM contracts', all: ROWS }]);
    await expect(db.prepare('SELECT * FROM lots').all()).rejects.toThrow(/no route matched/i);
  });

  it('rejects an unmatched first() as well as an unmatched all()', async () => {
    const { db } = fakeD1([{ when: 'FROM contracts', first: { n: 1 } }]);
    await expect(db.prepare('SELECT count(*) FROM lots').first()).rejects.toThrow(
      /no route matched/i,
    );
  });

  it('rejects a query that matches a route registered for the other method', async () => {
    // A route with only `all` must not satisfy first(): that is the same silent fall-through in a
    // different costume — the marker matched, the method did not, and a null would look like "no row".
    const { db } = fakeD1([{ when: 'FROM contracts', all: ROWS }]);
    await expect(db.prepare('SELECT * FROM contracts').first()).rejects.toThrow(
      /no route matched/i,
    );
  });

  it('names the offending SQL and every registered marker in the message', async () => {
    const { db } = fakeD1([
      { when: ['FROM contracts', 'GROUP BY'], all: ROWS },
      { when: 'FROM lots l', all: [] },
    ]);
    const error = await rejection(db.prepare('SELECT * FROM amendments WHERE unp = ?').all());
    expect(error.message).toContain('FROM amendments WHERE unp = ?');
    expect(error.message).toContain('FROM contracts');
    expect(error.message).toContain('GROUP BY');
    expect(error.message).toContain('FROM lots l');
  });

  it('says so plainly when the double has no routes at all', async () => {
    const error = await rejection(fakeD1([]).db.prepare('SELECT 1').all());
    expect(error.message).toContain('(none registered)');
  });

  it('truncates a long statement in the message rather than printing the whole query', async () => {
    const sql = `SELECT ${'x'.repeat(500)} FROM contracts`;
    const error = await rejection(
      fakeD1([{ when: 'FROM lots', all: [] }])
        .db.prepare(sql)
        .all(),
    );
    expect(error.message.length).toBeLessThan(sql.length);
    expect(error.message).toContain('…');
  });
});

describe('fakeD1 — emptiness as an explicit choice', () => {
  it('returns no rows for an unmatched query when onUnmatched is "empty"', async () => {
    const { db } = fakeD1([{ when: 'FROM contracts', all: ROWS }], { onUnmatched: 'empty' });
    await expect(db.prepare('SELECT * FROM lots').all()).resolves.toEqual({
      results: [],
      success: true,
      meta: {},
    });
  });

  it('returns null for an unmatched first() when onUnmatched is "empty"', async () => {
    const { db } = fakeD1([], { onUnmatched: 'empty' });
    await expect(db.prepare('SELECT 1').first()).resolves.toBeNull();
  });

  it('still serves matched routes when onUnmatched is "empty"', async () => {
    const { db } = fakeD1([{ when: 'FROM contracts', all: ROWS }], { onUnmatched: 'empty' });
    await expect(db.prepare('SELECT * FROM contracts').all()).resolves.toEqual({
      results: ROWS,
      success: true,
      meta: {},
    });
  });
});

describe('fakeD1 — routing', () => {
  it('requires every marker of a route to appear, not just one', async () => {
    const { db } = fakeD1([{ when: ['FROM contracts', 'GROUP BY'], all: ROWS }]);
    await expect(db.prepare('SELECT * FROM contracts').all()).rejects.toThrow(/no route matched/i);
  });

  it('matches any query when a route constrains nothing', async () => {
    const { db } = fakeD1([{ when: [], all: ROWS }]);
    await expect(db.prepare('LITERALLY ANYTHING').all()).resolves.toMatchObject({ results: ROWS });
  });

  it('takes the first matching route, so a specific one can precede a general one', async () => {
    const specific = [{ id: 'specific' }];
    const general = [{ id: 'general' }];
    const { db } = fakeD1([
      { when: ['FROM contracts', 'substr(t.cpv_code, 1, 2)'], all: specific },
      { when: 'FROM contracts', all: general },
    ]);
    const filtered = await db
      .prepare('SELECT * FROM contracts WHERE substr(t.cpv_code, 1, 2)')
      .all();
    const plain = await db.prepare('SELECT * FROM contracts').all();
    expect(filtered.results).toEqual(specific);
    expect(plain.results).toEqual(general);
  });
});

describe('fakeD1 — result metadata', () => {
  it('returns an empty meta by default', async () => {
    const { db } = fakeD1([{ when: 'SELECT', all: ROWS }]);
    await expect(db.prepare('SELECT 1').all()).resolves.toMatchObject({ meta: {} });
  });

  it('returns the meta a route declares — rows_read drives a real budget', async () => {
    const { db } = fakeD1([
      { when: 'SELECT', all: ROWS, meta: { rows_read: 250, total_attempts: 3 } },
    ]);
    const out = await db.prepare('SELECT 1').all();
    expect(out.meta).toMatchObject({ rows_read: 250, total_attempts: 3 });
  });
});

describe('fakeD1 — bound arguments', () => {
  it('hands the bound arguments to a function response', async () => {
    const { db } = fakeD1([
      {
        when: 'ORDER BY bidder_id',
        all: (call) => ROWS.filter((r) => r.id > String(call.binds.at(-2))),
      },
    ]);
    const page = await db.prepare('SELECT * ORDER BY bidder_id').bind('c:1', 10).all();
    expect(page.results).toEqual([{ id: 'c:2' }]);
  });

  it('gives a route with no bind() an empty binds array rather than undefined', async () => {
    const { db } = fakeD1([{ when: 'FROM contracts', all: (call) => [{ n: call.binds.length }] }]);
    const out = await db.prepare('SELECT * FROM contracts').all();
    expect(out.results).toEqual([{ n: 0 }]);
  });

  it('keeps each prepared statement independent — binding one does not leak into another', async () => {
    const { db } = fakeD1([{ when: 'SELECT', all: (call) => [{ binds: call.binds }] }]);
    const a = db.prepare('SELECT a').bind('A');
    const b = db.prepare('SELECT b').bind('B');
    expect((await a.all()).results).toEqual([{ binds: ['A'] }]);
    expect((await b.all()).results).toEqual([{ binds: ['B'] }]);
  });
});

describe('fakeD1 — recording', () => {
  it('records every prepared statement in order, with its bound arguments', async () => {
    const fake = fakeD1([{ when: 'SELECT', all: [] }]);
    await fake.db.prepare('SELECT a').bind(1).all();
    await fake.db.prepare('SELECT b').all();
    expect(fake.calls).toEqual([
      { sql: 'SELECT a', binds: [1], via: 'prepare' },
      { sql: 'SELECT b', binds: [], via: 'prepare' },
    ]);
  });

  it('exposes the executed SQL strings for assertions', async () => {
    const fake = fakeD1([{ when: 'SELECT', all: [] }]);
    await fake.db.prepare('SELECT a').all();
    await fake.db.prepare('SELECT b').all();
    expect(fake.sql).toEqual(['SELECT a', 'SELECT b']);
  });

  it('keeps `sql` live after destructuring — `const { db, sql } = fakeD1(...)`', async () => {
    // A getter here would hand back an empty snapshot at destructure time and never fill in, so
    // every later assertion would read nothing and pass for the wrong reason.
    const { db, sql } = fakeD1([{ when: 'SELECT', all: [] }]);
    await db.prepare('SELECT a').all();
    expect(sql).toEqual(['SELECT a']);
  });

  it('records a statement that goes on to throw, so the offending SQL is inspectable', async () => {
    const fake = fakeD1([{ when: 'FROM contracts', all: [] }]);
    await fake.db
      .prepare('SELECT * FROM lots')
      .all()
      .catch(() => undefined);
    expect(fake.sql).toEqual(['SELECT * FROM lots']);
  });
});

describe('fakeD1 — first() and run()', () => {
  it('returns the row of a matching first() route', async () => {
    const { db } = fakeD1([{ when: 'WHERE c.id = ?', first: { id: 'c:1' } }]);
    await expect(db.prepare('SELECT * WHERE c.id = ?').first()).resolves.toEqual({ id: 'c:1' });
  });

  it('computes a first() row from the call when the route is a function', async () => {
    const { db } = fakeD1([{ when: 'WHERE c.id = ?', first: (call) => ({ id: call.binds[0] }) }]);
    await expect(db.prepare('SELECT * WHERE c.id = ?').bind('c:9').first()).resolves.toEqual({
      id: 'c:9',
    });
  });

  it('returns null for a route that deliberately answers "no such row"', async () => {
    // Distinct from an unmatched query: the marker matched and the answer is "nothing there".
    const { db } = fakeD1([{ when: 'company_totals', first: null }]);
    await expect(db.prepare('SELECT * FROM company_totals').first()).resolves.toBeNull();
  });

  it('invokes a matching run() route with the call', async () => {
    const seen: FakeD1Call[] = [];
    const { db } = fakeD1([{ when: 'DELETE FROM staging', run: (call) => seen.push(call) }]);
    await expect(db.prepare('DELETE FROM staging WHERE id = ?').bind(7).run()).resolves.toEqual({
      results: [],
      success: true,
      meta: {},
    });
    expect(seen).toEqual([{ sql: 'DELETE FROM staging WHERE id = ?', binds: [7], via: 'prepare' }]);
  });

  it('rejects an unmatched run()', async () => {
    const { db } = fakeD1([{ when: 'DELETE FROM staging', run: () => undefined }]);
    await expect(db.prepare('DELETE FROM lots').run()).rejects.toThrow(/no route matched/i);
  });

  it('records an exec() alongside the prepared statements', async () => {
    const fake = fakeD1([{ when: 'PRAGMA optimize', run: () => undefined }]);
    await fake.db.exec('PRAGMA optimize');
    expect(fake.sql).toEqual(['PRAGMA optimize']);
  });

  it('refuses a batch() statement that came from another database', async () => {
    // Re-recording an unknown statement would put an empty string in the call log and quietly
    // corrupt every assertion made against it.
    const fake = fakeD1([]);
    const foreign = { bind: () => foreign } as unknown as D1PreparedStatement;
    await expect(fake.db.batch([foreign])).rejects.toThrow(/another database/i);
  });
});

describe('fakeD1 — exec() and batch() answer to the same contract', () => {
  // The write paths in production reach D1 only through batch() (staging, refresh, fx) — never
  // through prepare().run(). A batch that succeeded whatever it was handed would put the silent
  // pass this helper exists to kill on the one entry point those paths use.

  it('rejects a batch() statement no route matches', async () => {
    const fake = fakeD1([{ when: 'DELETE FROM staging', run: () => undefined }]);
    const error = await rejection(fake.db.batch([fake.db.prepare('INSERT INTO no_such_table')]));
    expect(error.message).toMatch(/no route matched this batch\(\) query/i);
    expect(error.message).toContain('INSERT INTO no_such_table');
  });

  it('rejects the unmatched statement even when an earlier one in the batch matched', async () => {
    const fake = fakeD1([{ when: 'DELETE FROM staging', run: () => undefined }]);
    await expect(
      fake.db.batch([
        fake.db.prepare('DELETE FROM staging'),
        fake.db.prepare('INSERT INTO no_such_table'),
      ]),
    ).rejects.toThrow(/no route matched/i);
  });

  it('invokes the matching run() route for each batched statement, with its own binds', async () => {
    const seen: FakeD1Call[] = [];
    const fake = fakeD1([{ when: 'DELETE FROM staging', run: (call) => seen.push(call) }]);
    await fake.db.batch([
      fake.db.prepare('DELETE FROM staging WHERE id = ?').bind(1),
      fake.db.prepare('DELETE FROM staging WHERE id = ?').bind(2),
    ]);
    expect(seen.map((call) => call.binds)).toEqual([[1], [2]]);
    expect(seen.map((call) => call.via)).toEqual(['prepare', 'prepare']);
  });

  it('serves the rows of a matching all() route to a batched SELECT', async () => {
    const fake = fakeD1([{ when: 'FROM contracts', all: ROWS, meta: { rows_read: 2 } }]);
    await expect(fake.db.batch([fake.db.prepare('SELECT * FROM contracts')])).resolves.toEqual([
      { results: ROWS, success: true, meta: { rows_read: 2 } },
    ]);
  });

  it('lets a batched statement through without a route when onUnmatched is "empty"', async () => {
    const fake = recordingD1();
    await expect(fake.db.batch([fake.db.prepare('INSERT INTO anything')])).resolves.toEqual([
      { results: [], success: true, meta: {} },
    ]);
  });

  it('rejects an exec() no route matches', async () => {
    const fake = fakeD1([{ when: 'PRAGMA optimize', run: () => undefined }]);
    await expect(fake.db.exec('DROP TABLE contracts')).rejects.toThrow(
      /no route matched this exec\(\) query/i,
    );
  });

  it('invokes the matching run() route for an exec()', async () => {
    const seen: FakeD1Call[] = [];
    const fake = fakeD1([{ when: 'PRAGMA optimize', run: (call) => seen.push(call) }]);
    await fake.db.exec('PRAGMA optimize');
    expect(seen.map((call) => call.via)).toEqual(['exec']);
  });

  it('carries the rows key a real D1Result always has, on run() and batch() alike', async () => {
    // Masked by the cast to D1Database: without it a reader gets `undefined` from the double where
    // real D1 hands back `[]`.
    const fake = fakeD1([{ when: 'DELETE FROM staging', run: () => undefined }]);
    await expect(fake.db.prepare('DELETE FROM staging').run()).resolves.toEqual({
      results: [],
      success: true,
      meta: {},
    });
    await expect(fake.db.batch([fake.db.prepare('DELETE FROM staging')])).resolves.toEqual([
      { results: [], success: true, meta: {} },
    ]);
  });
});

describe('fakeD1 — a batched statement is routed by what it does', () => {
  // Matching on markers alone is blind to the method: `FROM staging` is a substring of
  // `DELETE FROM staging`, so a read-only route would answer a write with its rows — the same
  // silent pass, one marker collision away. A batched write wants `run:`; a batched SELECT wants
  // `all:`; neither will settle for the other.

  it('rejects a batched write whose only matching route is read-only', async () => {
    const fake = fakeD1([{ when: 'FROM staging', all: [{ id: 1 }] }]);
    const error = await rejection(
      fake.db.batch([fake.db.prepare('DELETE FROM staging WHERE id = 1')]),
    );
    expect(error.message).toMatch(/no route matched this batch\(\) query/i);
  });

  it('rejects a batched SELECT whose only matching route is a write effect', async () => {
    const fake = fakeD1([{ when: 'FROM staging', run: () => undefined }]);
    await expect(fake.db.batch([fake.db.prepare('SELECT id FROM staging')])).rejects.toThrow(
      /no route matched/i,
    );
  });

  it('serves a batched write from its run() route, and carries RETURNING rows if it has them', async () => {
    const seen: FakeD1Call[] = [];
    const fake = fakeD1([
      { when: 'INSERT INTO staging', run: (call) => seen.push(call), all: [{ id: 9 }] },
    ]);
    await expect(
      fake.db.batch([fake.db.prepare('INSERT INTO staging VALUES (?) RETURNING id').bind(9)]),
    ).resolves.toEqual([{ results: [{ id: 9 }], success: true, meta: {} }]);
    expect(seen.map((call) => call.binds)).toEqual([[9]]);
  });

  it('does not fire a write effect for a batched SELECT that happens to match it', async () => {
    let fired = 0;
    const fake = fakeD1([
      { when: 'FROM staging', run: () => (fired += 1) },
      { when: 'FROM staging', all: [{ id: 1 }] },
    ]);
    await fake.db.batch([fake.db.prepare('SELECT id FROM staging')]);
    expect(fired).toBe(0);
  });

  it('treats a leading WITH as the read it usually is', async () => {
    const fake = fakeD1([{ when: 'FROM staging', all: [{ id: 1 }] }]);
    await expect(
      fake.db.batch([fake.db.prepare('WITH x AS (SELECT 1) SELECT id FROM staging')]),
    ).resolves.toEqual([{ results: [{ id: 1 }], success: true, meta: {} }]);
  });

  it('rejects an exec() whose matching route answers a different method', async () => {
    // exec() returns no rows, so `run:` is the only responder that means anything to it.
    const fake = fakeD1([{ when: 'PRAGMA optimize', all: [] }]);
    await expect(fake.db.exec('PRAGMA optimize')).rejects.toThrow(/no route matched this exec/i);
  });

  it('carries the route meta on run(), the same as batch() does for the same statement', async () => {
    const fake = fakeD1([
      { when: 'DELETE FROM staging', run: () => undefined, meta: { changes: 5 } },
    ]);
    expect(await fake.db.prepare('DELETE FROM staging').run()).toEqual({
      results: [],
      success: true,
      meta: { changes: 5 },
    });
    expect(await fake.db.batch([fake.db.prepare('DELETE FROM staging')])).toEqual([
      { results: [], success: true, meta: { changes: 5 } },
    ]);
  });
});

describe('throwingD1', () => {
  it('rejects when the statement executes, not when it is prepared', async () => {
    // D1's prepare() is lazy: a missing table surfaces on all()/first(), and a double that threw
    // earlier would let a test pass an error-handling path it never actually reaches.
    const { db } = throwingD1();
    const statement = db.prepare('SELECT 1');
    await expect(statement.all()).rejects.toThrow();
  });

  it('rejects the supplied error from all(), first() and run() alike', async () => {
    const { db } = throwingD1(new Error('D1_ERROR: no such table'));
    await expect(db.prepare('SELECT 1').all()).rejects.toThrow('D1_ERROR: no such table');
    await expect(db.prepare('SELECT 1').first()).rejects.toThrow('D1_ERROR: no such table');
    await expect(db.prepare('SELECT 1').run()).rejects.toThrow('D1_ERROR: no such table');
  });

  it('attributes bind() to its own statement, not the most recent one', async () => {
    const fake = throwingD1();
    const a = fake.db.prepare('SELECT a WHERE x = ?');
    const b = fake.db.prepare('SELECT b WHERE y = ?');
    b.bind('B');
    a.bind('A');
    expect(fake.calls.map((call) => call.binds)).toEqual([['A'], ['B']]);
  });

  it('records the statement that failed, with its bound arguments', async () => {
    const fake = throwingD1();
    await fake.db
      .prepare('SELECT * FROM interest_links WHERE link_key = ?')
      .bind('p1|111')
      .all()
      .catch(() => undefined);
    expect(fake.calls).toEqual([
      { sql: 'SELECT * FROM interest_links WHERE link_key = ?', binds: ['p1|111'], via: 'prepare' },
    ]);
  });
});

describe('recordingD1', () => {
  // For the tests that exercise a *wrapper* over D1 (readonlyD1) rather than a query: they must
  // accept arbitrary SQL and assert on the exact call log, so marker dispatch is the wrong shape.
  it('accepts any SQL without a registered route', async () => {
    const fake = recordingD1();
    await expect(fake.db.prepare('ANYTHING AT ALL').all()).resolves.toEqual({
      results: [],
      success: true,
      meta: {},
    });
  });

  it('records prepare, bind, exec, run and batch in one ordered log', async () => {
    const fake = recordingD1();
    fake.db.prepare('SELECT a').bind(1);
    await fake.db.exec('PRAGMA foreign_keys = ON');
    await fake.db.prepare('SELECT b').run();
    await fake.db.batch([fake.db.prepare('SELECT c')]);
    expect(fake.sql).toEqual([
      'SELECT a',
      'PRAGMA foreign_keys = ON',
      'SELECT b',
      'SELECT c',
      'SELECT c',
    ]);
  });

  it('distinguishes an exec() from a prepare() carrying the same text', async () => {
    const fake = recordingD1();
    fake.db.prepare('SELECT 1');
    await fake.db.exec('SELECT 1');
    expect(fake.calls.map((call) => call.via)).toEqual(['prepare', 'exec']);
  });

  it('serves a registered route while still allowing anything else through', async () => {
    const fake = recordingD1([{ when: 'FROM contracts', all: ROWS }]);
    expect((await fake.db.prepare('SELECT * FROM contracts').all()).results).toEqual(ROWS);
    expect((await fake.db.prepare('SELECT * FROM lots').all()).results).toEqual([]);
  });
});
