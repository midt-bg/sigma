// The one hand-rolled D1 double in the repo (#325).
//
// Before this existed, every test needing a D1 binding built its own: `prepare(sql)` dispatched on
// `sql.includes('…')` and returned a fixture for whichever branch matched. Rename a CTE or reorder a
// JOIN and the marker stops matching — the double returns no rows, and the test passes against
// emptiness having asserted nothing. A test that goes green while testing nothing is worse than one
// that goes red, so here an unmatched query THROWS and emptiness is something a test asks for.
//
// Not a replacement for the d1-sqlite.ts facade beside it: that runs the real SQL against a real
// node:sqlite database. This one is for unit tests of the TypeScript logic *around* a query, where
// the SQL itself is not under test. scripts/check-fake-d1.mjs keeps both of them the only two.

/** One statement the double was handed — the SQL, whatever `bind()` put on it, and how it arrived. */
export interface FakeD1Call {
  sql: string;
  binds: unknown[];
  /**
   * Which entry point recorded it. Tests of a *wrapper* over D1 need this: `prepare` and `exec`
   * carry the same text, so without it a wrapper that sent an exec down the prepare path would
   * produce an identical log and the test could not tell.
   */
  via: 'prepare' | 'exec' | 'batch';
}

/**
 * A marker set and the response it serves. Every string in `when` must appear in the SQL for the
 * route to match, and the first matching route wins — so a specific route can precede a general one.
 *
 * `when: []` constrains nothing and therefore matches any query. Use it last, and only where the
 * test genuinely does not care which statement ran — asserting on the call log, say.
 */
export interface FakeD1Route {
  when: string | string[];
  all?: unknown[] | ((call: FakeD1Call) => unknown[]);
  // `object | null`, not `unknown`: a top type absorbs the whole union, and the callback form would
  // silently lose its parameter type. A D1 row is an object or nothing, so this is also the truth.
  first?: object | null | ((call: FakeD1Call) => object | null);
  run?: (call: FakeD1Call) => void;
  /**
   * The `meta` D1 returns beside the rows. Defaults to `{}`; set it where the test is about what
   * meta carries — `rows_read` and `total_attempts` drive the assistant's rows-read budget.
   */
  meta?: Record<string, unknown> | ((call: FakeD1Call) => Record<string, unknown>);
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

/**
 * Whether a batched statement reads. Leading keyword only: a CTE that goes on to write
 * (`WITH … INSERT`) reads as a SELECT here, which costs a false rejection rather than a false pass —
 * the route it then demands is simply the one it does not have.
 */
const READ = /^\s*(?:SELECT|WITH)\b/i;

function resolve<T>(value: T | ((call: FakeD1Call) => T), call: FakeD1Call): T {
  return typeof value === 'function' ? (value as (c: FakeD1Call) => T)(call) : value;
}

function build(routes: FakeD1Route[], options: FakeD1Options): FakeD1 {
  const lenient = options.onUnmatched === 'empty';
  const calls: FakeD1Call[] = [];
  const sql: string[] = [];
  const bound = new WeakMap<object, FakeD1Call>();

  const record = (statement: string, via: FakeD1Call['via']): FakeD1Call => {
    const call: FakeD1Call = { sql: statement, binds: [], via };
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

  /** The first route answering `method` for this SQL — the route itself, where `meta` lives. */
  const answering = (method: 'all' | 'run', call: FakeD1Call): FakeD1Route | undefined =>
    routes.find((r) => r[method] !== undefined && matches(r, call.sql));

  const statement = (call: FakeD1Call) => {
    const self = {
      bind(...args: unknown[]) {
        call.binds = args;
        return self;
      },
      async all() {
        // The route itself, not `responder()`'s response: `meta` belongs to whichever route
        // answered, so all() needs the pair. `=== undefined` rather than a falsy test — `all: []`
        // is a route that deliberately answers "no rows".
        const hit = answering('all', call);
        if (hit?.all === undefined) {
          if (!lenient) throw unmatched('all', call.sql, routes);
          return { results: [], success: true, meta: {} };
        }
        return {
          results: resolve(hit.all, call),
          success: true,
          meta: resolve(hit.meta ?? {}, call),
        };
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
        const hit = answering('run', call);
        if (hit?.run === undefined) {
          if (!lenient) throw unmatched('run', call.sql, routes);
          return { results: [], success: true, meta: {} };
        }
        hit.run(call);
        return { results: [], success: true, meta: resolve(hit.meta ?? {}, call) };
      },
    };
    bound.set(self, call);
    return self;
  };

  const db = {
    prepare(statement_: string) {
      return statement(record(statement_, 'prepare'));
    },
    async exec(statement_: string) {
      // exec() hands back no rows, so `run:` is the only responder that means anything to it.
      const call = record(statement_, 'exec');
      const hit = answering('run', call);
      if (hit?.run === undefined && !lenient) throw unmatched('exec', call.sql, routes);
      hit?.run?.(call);
      return { count: 0, duration: 0 };
    },
    async batch(statements: object[]) {
      // Not transactional: a statement that throws leaves the effects of the ones before it. Real
      // D1 rolls the batch back, and so does the d1-sqlite.ts facade beside this. A test that
      // asserts state AFTER a failed batch belongs on the facade, not here — this double is for the
      // TypeScript logic around the statements, not for their atomicity.
      const results = [];
      for (const entry of statements) {
        const call = bound.get(entry);
        // A statement not made by this double has no recorded SQL; re-recording an empty string
        // would quietly corrupt the call log, so refuse rather than guess.
        if (!call) throw new Error('fake D1: batch() received a statement from another database');
        // A second record, under `via: 'batch'`: the prepare() that built this statement already
        // logged it, and a test asserting how a write reached D1 needs to tell the two apart. Not
        // a double count — `calls` logs entry points, not distinct statements.
        record(call.sql, 'batch');
        // Routed by what the statement does, not by markers alone: `FROM staging` is a substring of
        // `DELETE FROM staging`, so a read-only route would otherwise answer a write with its rows.
        const read = READ.test(call.sql);
        const route = answering(read ? 'all' : 'run', call);
        if (route === undefined) {
          if (!lenient) throw unmatched('batch', call.sql, routes);
          results.push({ results: [], success: true, meta: {} });
          continue;
        }
        if (!read) route.run?.(call);
        results.push({
          // A write serves rows too when it has them — INSERT … RETURNING is still a write.
          results: route.all === undefined ? [] : resolve(route.all, call),
          success: true,
          meta: resolve(route.meta ?? {}, call),
        });
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
      // Capture this statement's own record: reading back the last entry would attribute a bind() to
      // whichever statement was prepared most recently, not the one it was called on.
      const call: FakeD1Call = { sql: statement, binds: [], via: 'prepare' };
      calls.push(call);
      sql.push(statement);
      const self = {
        bind(...args: unknown[]) {
          call.binds = args;
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
