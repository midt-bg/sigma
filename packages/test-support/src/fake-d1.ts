// The one hand-rolled D1 double in the repo (#325).
//
// Before this existed, every test needing a D1 binding built its own: `prepare(sql)` dispatched on
// `sql.includes('…')` and returned a fixture for whichever branch matched. Rename a CTE or reorder a
// JOIN and the marker stops matching — the double returns no rows, and the test passes against
// emptiness having asserted nothing. A test that goes green while testing nothing is worse than one
// that goes red, so here an unmatched query THROWS and emptiness is something a test asks for.
//
// Not a replacement for packages/ingest/src/test/d1-sqlite.ts: that runs the real SQL against a real
// node:sqlite database. This one is for unit tests of the TypeScript logic *around* a query, where
// the SQL itself is not under test. scripts/check-fake-d1.mjs keeps both of them the only two.

/** One `prepare()` — the SQL, and whatever `bind()` put on it. */
export interface FakeD1Call {
  sql: string;
  binds: unknown[];
}

/**
 * A marker set and the response it serves. Every string in `when` must appear in the SQL for the
 * route to match, and the first matching route wins — so a specific route can precede a general one.
 */
export interface FakeD1Route {
  when: string | string[];
  all?: unknown[] | ((call: FakeD1Call) => unknown[]);
  // `object | null`, not `unknown`: a top type absorbs the whole union, and the callback form would
  // silently lose its parameter type. A D1 row is an object or nothing, so this is also the truth.
  first?: object | null | ((call: FakeD1Call) => object | null);
  run?: (call: FakeD1Call) => void;
}

export interface FakeD1 {
  /** The binding. The repo's only `as unknown as D1Database` lives behind this field. */
  db: D1Database;
  /** Every `prepare()`, in order, with the arguments `bind()` gave it. */
  calls: FakeD1Call[];
  /**
   * The executed SQL strings, for assertions that only care about text. A live array kept in step
   * with `calls`, not a getter: `const { db, sql } = fake()` is the natural way to use this, and a
   * getter would hand back an empty snapshot that never fills in.
   */
  sql: string[];
}

export interface FakeD1Options {
  /**
   * What an unmatched query does. `'throw'` is the default and the point of the helper; `'empty'`
   * returns no rows, and exists so that choice is visible at the call site instead of inherited.
   */
  onUnmatched?: 'throw' | 'empty';
}

const SQL_EXCERPT = 160;

function markers(route: FakeD1Route): string[] {
  return typeof route.when === 'string' ? [route.when] : route.when;
}

function matches(route: FakeD1Route, sql: string): boolean {
  return markers(route).every((marker) => sql.includes(marker));
}

function unmatched(method: string, sql: string, routes: FakeD1Route[]): Error {
  const excerpt = sql.length > SQL_EXCERPT ? `${sql.slice(0, SQL_EXCERPT).trimEnd()}…` : sql;
  const registered =
    routes.length === 0
      ? '(none registered)'
      : routes
          .map((r) =>
            markers(r)
              .map((m) => JSON.stringify(m))
              .join(' + '),
          )
          .join(', ');
  return new Error(
    `fake D1: no route matched this ${method}() query.\n` +
      `  sql    : ${excerpt}\n` +
      `  markers: ${registered}\n` +
      'Add a route whose markers appear in that SQL. If the query really should return nothing, ' +
      "say so — give the route an empty response, or pass { onUnmatched: 'empty' } (#325).",
  );
}

function resolve<T>(value: T | ((call: FakeD1Call) => T), call: FakeD1Call): T {
  return typeof value === 'function' ? (value as (c: FakeD1Call) => T)(call) : value;
}

function build(routes: FakeD1Route[], options: FakeD1Options): FakeD1 {
  const lenient = options.onUnmatched === 'empty';
  const calls: FakeD1Call[] = [];
  const sql: string[] = [];
  const bound = new WeakMap<object, FakeD1Call>();

  const record = (statement: string): FakeD1Call => {
    const call: FakeD1Call = { sql: statement, binds: [] };
    calls.push(call);
    sql.push(statement);
    return call;
  };

  /**
   * The response the first matching route gives for this method, or `undefined` when none answers
   * it. Returning the response rather than the route keeps `first: null` — a route that means "no
   * such row" — distinguishable from no route at all.
   */
  const responder = <K extends 'all' | 'first' | 'run'>(
    method: K,
    call: FakeD1Call,
  ): FakeD1Route[K] | undefined =>
    routes.find((r) => r[method] !== undefined && matches(r, call.sql))?.[method];

  const statement = (call: FakeD1Call) => {
    const self = {
      bind(...args: unknown[]) {
        call.binds = args;
        return self;
      },
      async all() {
        const rows = responder('all', call);
        if (rows === undefined) {
          if (!lenient) throw unmatched('all', call.sql, routes);
          return { results: [], success: true, meta: {} };
        }
        return { results: resolve(rows, call), success: true, meta: {} };
      },
      async first() {
        const row = responder('first', call);
        if (row === undefined) {
          if (!lenient) throw unmatched('first', call.sql, routes);
          return null;
        }
        return resolve(row, call) ?? null;
      },
      async run() {
        const effect = responder('run', call);
        if (effect === undefined) {
          if (!lenient) throw unmatched('run', call.sql, routes);
          return { success: true, meta: {} };
        }
        effect(call);
        return { success: true, meta: {} };
      },
    };
    bound.set(self, call);
    return self;
  };

  const db = {
    prepare(sql: string) {
      return statement(record(sql));
    },
    async exec(sql: string) {
      record(sql);
      return { count: 0, duration: 0 };
    },
    async batch(statements: object[]) {
      const results = [];
      for (const entry of statements) {
        const call = bound.get(entry);
        // A statement not made by this double has no recorded SQL; re-recording an empty string
        // would quietly corrupt the call log, so refuse rather than guess.
        if (!call) throw new Error('fake D1: batch() received a statement from another database');
        record(call.sql);
        results.push({ results: [], success: true, meta: {} });
      }
      return results;
    },
  } as unknown as D1Database;

  return { db, calls, sql };
}

/**
 * A D1 double that serves `routes` and throws on anything else.
 *
 * ```ts
 * const { db } = fakeD1([
 *   { when: 'WHERE c.id = ?', first: contractRow },
 *   { when: 'FROM lots l', all: lotRows },
 * ]);
 * ```
 */
export function fakeD1(routes: FakeD1Route[], options: FakeD1Options = {}): FakeD1 {
  return build(routes, { onUnmatched: 'throw', ...options });
}

/**
 * A permissive double: it answers anything, records everything, and returns no rows where no route
 * applies. For tests of a *wrapper* over D1 (readonlyD1), which must accept arbitrary SQL and assert
 * on the call log — marker dispatch is the wrong shape there. Use `fakeD1` for query tests.
 */
export function recordingD1(routes: FakeD1Route[] = []): FakeD1 {
  return build(routes, { onUnmatched: 'empty' });
}

/**
 * A double whose statements fail when they execute — for the error paths (an un-migrated
 * environment, a missing table). It fails at execution rather than at `prepare()` because that is
 * where D1 itself surfaces these: `prepare()` is lazy and never touches the database. The statement
 * is still recorded, so the SQL that failed is inspectable.
 */
export function throwingD1(error: Error = new Error('D1_ERROR: statement failed')): FakeD1 {
  const calls: FakeD1Call[] = [];
  const sql: string[] = [];
  const db = {
    prepare(statement: string) {
      calls.push({ sql: statement, binds: [] });
      sql.push(statement);
      const self = {
        bind(...args: unknown[]) {
          const call = calls.at(-1);
          if (call) call.binds = args;
          return self;
        },
        all(): Promise<never> {
          return Promise.reject(error);
        },
        first(): Promise<never> {
          return Promise.reject(error);
        },
        run(): Promise<never> {
          return Promise.reject(error);
        },
      };
      return self;
    },
  } as unknown as D1Database;
  return { db, calls, sql };
}
