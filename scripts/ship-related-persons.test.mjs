import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertShipFloor,
  assertD1TargetAuthorized,
  SHIP_TARGETS,
  parseMinLinks,
  resolveD1Name,
  insertStatements,
  chunkStatements,
  runShip,
  assertShippedCounts,
  sqlLiteral,
  sqlIdent,
  TABLES,
} from './ship-related-persons.mjs';

test('sqlLiteral escapes quotes, strips NUL, and NULLs non-finite/absent', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(Infinity), 'NULL');
  assert.equal(sqlLiteral(NaN), 'NULL');
  assert.equal(sqlLiteral("Д'Артанян"), "'Д''Артанян'"); // single quote doubled — injection-safe
  assert.equal(sqlLiteral('a\x00b'), "'ab'"); // NUL stripped
  // boolean/bigint map to explicit SQL forms, never String(v) → 'true' / a mistyped literal (ydimitrof #226)
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(false), '0');
  assert.equal(sqlLiteral(9007199254740993n), '9007199254740993');
});

test('sqlIdent double-quotes and escapes identifiers', () => {
  assert.equal(sqlIdent('persons'), '"persons"');
  assert.equal(sqlIdent('we"ird'), '"we""ird"');
});

test('insertStatements builds a valid multi-row INSERT with escaped values', () => {
  const stmts = insertStatements(
    'persons',
    ['id', 'name'],
    [
      { id: 'person:a', name: 'Иван' },
      { id: 'person:b', name: "О'Брайън" },
    ],
  );
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /^INSERT INTO "persons" \("id", "name"\) VALUES\n/);
  assert.match(stmts[0], /\('person:a','Иван'\)/);
  assert.match(stmts[0], /\('person:b','О''Брайън'\)/); // escaped
  assert.match(stmts[0], /;\n$/);
});

test('insertStatements batches by row count (MAX_BATCH_ROWS)', () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
  const stmts = insertStatements('persons', ['id', 'name'], rows);
  // 900 rows / 400-row cap → 3 statements (400 + 400 + 100)
  assert.equal(stmts.length, 3);
  assert.ok(stmts.every((s) => s.startsWith('INSERT INTO "persons"')));
});

test('insertStatements yields nothing for empty columns or rows', () => {
  assert.deepEqual(insertStatements('persons', [], [{ id: 'x' }]), []);
  assert.deepEqual(insertStatements('persons', ['id'], []), []);
});

test('TABLES ships parents before children and covers the served related-persons schema', () => {
  // Suppressions are NOT a served table (ADR-0031) — they are applied at load, so nothing to ship here.
  assert.ok(!TABLES.includes('link_suppressions'), 'suppressions must not ship to prod');
  assert.equal(TABLES[0], 'persons'); // parent first, so children never reference a missing row
  for (const t of [
    'persons',
    'declarations',
    'declared_interests',
    'interest_links',
    'interest_link_authorities',
  ]) {
    assert.ok(TABLES.includes(t), `missing ${t}`);
  }
});

test('assertD1TargetAuthorized: declared env + allowlisted name + (name↔id) before a remote wipe (T48)', () => {
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const ok = {
    remote: true,
    shipEnv: 'production',
    d1Name: 'sigma-blue',
    expectedId: ID,
    resolvedId: ID,
  };
  // --local (remote=false) is exempt — no durable blast radius, so any/absent env/ids pass.
  assert.doesNotThrow(() =>
    assertD1TargetAuthorized({
      remote: false,
      shipEnv: '',
      d1Name: 'sigma',
      expectedId: '',
      resolvedId: '',
    }),
  );
  // remote: declared env + allowlisted name + matching (name→id) pair is allowed.
  assert.doesNotThrow(() => assertD1TargetAuthorized(ok));
  // production is blue-green: the partner slot `sigma-green` is also allowed for env=production.
  assert.doesNotThrow(() => assertD1TargetAuthorized({ ...ok, d1Name: 'sigma-green' }));
  // missing / unknown declared env → cannot anchor authorization → refuse.
  assert.throws(() => assertD1TargetAuthorized({ ...ok, shipEnv: '' }), /SIGMA_SHIP_ENV must name/);
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, shipEnv: 'prod' }),
    /SIGMA_SHIP_ENV must name/,
  );
  // THE T48 CASE: a consistent-but-wrong pair (staging name + its own id) when PRODUCTION was declared — the
  // repo policy refuses it even though name and id agree with each other.
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, d1Name: 'sigma-stage', resolvedId: ID }),
    /not an allowed target for SIGMA_SHIP_ENV='production'/,
  );
  // THE MIRROR CASE (#226): BOTH real prod blue-green slots under a non-production declared env → refuse (meant
  // dev, wiped prod). Regression guard — a stale PRODUCTION_SLOTS previously omitted `sigma-blue`, so naming the
  // real prod slot from a dev run slipped past this denylist, collapsing two defenses (name + id) to one.
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, shipEnv: 'dev', d1Name: 'sigma-blue' }),
    /is a PRODUCTION slot but SIGMA_SHIP_ENV='dev'/,
  );
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, shipEnv: 'dev', d1Name: 'sigma-green' }),
    /is a PRODUCTION slot but SIGMA_SHIP_ENV='dev'/,
  );
  // no expected id → cannot verify → refuse.
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, expectedId: '' }),
    /SIGMA_D1_ID must be set/,
  );
  // name resolves to nothing (unknown/typo at Cloudflare) → refuse.
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, resolvedId: '' }),
    /could not resolve a database id/,
  );
  // name resolves to a DIFFERENT id than the Environment expects → refuse (the core wrong-target guard).
  assert.throws(
    () => assertD1TargetAuthorized({ ...ok, resolvedId: 'ffffffff-0000-0000-0000-000000000000' }),
    /D1 target mismatch/,
  );
  // a non-production env with its own (non-prod) name + matching id passes.
  assert.doesNotThrow(() =>
    assertD1TargetAuthorized({ ...ok, shipEnv: 'staging', d1Name: 'sigma-stage' }),
  );
  assert.ok(SHIP_TARGETS.production.includes('sigma-blue'));
  assert.ok(SHIP_TARGETS.production.includes('sigma-green'));
  assert.ok(!SHIP_TARGETS.production.includes('sigma')); // there is no slot named `sigma` (#226)
});

test('assertShipFloor refuses to wipe the live surface below the floor (empty/partial staging)', () => {
  assert.throws(() => assertShipFloor(0, 50), /refusing to ship: 0 published links/); // the empty-wipe case
  assert.throws(() => assertShipFloor(49, 50), /< floor 50/);
  assert.doesNotThrow(() => assertShipFloor(50, 50)); // exactly at the floor is allowed
  assert.doesNotThrow(() => assertShipFloor(256, 50)); // healthy count
  assert.doesNotThrow(() => assertShipFloor(3, 3)); // an intentional small set via --min-links=3
  assert.throws(() => assertShipFloor(2, 3)); // …but one below it still refuses
});

test('parseMinLinks rejects the valueless-flag footgun and non-positive-integers', () => {
  // the footgun: a bare `--min-links` → arg() returns `true` → Number(true)=1 collapses the floor 50→1
  assert.throws(() => parseMinLinks(true), /requires a value/);
  assert.throws(() => parseMinLinks('abc'), /positive integer/); // non-numeric
  assert.throws(() => parseMinLinks('0'), /positive integer/); // zero disables the floor
  assert.throws(() => parseMinLinks('-5'), /positive integer/);
  assert.throws(() => parseMinLinks('2.5'), /positive integer/); // non-integer
  assert.equal(parseMinLinks(50), 50); // default (flag absent) passes through
  assert.equal(parseMinLinks('25'), 25); // --min-links=25
});

test('resolveD1Name refuses the prod default on a remote ship but keeps it for --local', () => {
  // The prod-wipe footgun: --remote with an unset SIGMA_D1_NAME must NOT silently fall back to 'sigma'.
  assert.throws(
    () => resolveD1Name({ remote: true, envName: undefined }),
    /must be set for a --remote/,
  );
  assert.throws(() => resolveD1Name({ remote: true, envName: '' }), /must be set for a --remote/);
  assert.equal(resolveD1Name({ remote: true, envName: 'sigma-stage' }), 'sigma-stage'); // explicit is fine
  assert.equal(resolveD1Name({ remote: false, envName: undefined }), 'sigma'); // --local has no blast radius
});

test('related_persons_internal (relative-name PII) is NOT shipped to the served D1', () => {
  // No served query reads it; shipping PII we never surface is a latent exposure. It stays in the
  // build/work DB only. If a real read path is ever added, ship it deliberately and revisit anonymization.
  assert.ok(!TABLES.includes('related_persons_internal'));
});

// The first full-corpus ship put 516k rows through in one hour, p90 batch 18.2s, and the database then
// returned „internal error" for hours. Chunking bounds what a single request carries; these lock the
// boundaries so a refactor cannot quietly restore the one-request-per-table shape.
test('chunkStatements splits into request-sized groups and preserves order', () => {
  const stmts = Array.from({ length: 7 }, (_, i) => `S${i};`);
  assert.deepEqual(chunkStatements(stmts, 3), [
    ['S0;', 'S1;', 'S2;'],
    ['S3;', 'S4;', 'S5;'],
    ['S6;'],
  ]);
  assert.deepEqual(chunkStatements(stmts, 100), [stmts], 'fits in one request');
  assert.deepEqual(chunkStatements([], 3), [], 'nothing to ship, nothing to send');
});

test('chunkStatements refuses a non-positive size rather than looping forever', () => {
  assert.throws(() => chunkStatements(['a'], 0), /positive integer/);
  assert.throws(() => chunkStatements(['a'], -1), /positive integer/);
  assert.throws(() => chunkStatements(['a'], 1.5), /positive integer/);
});

// The ship wipes, then writes over SEVERAL requests with no cross-request transaction. Before this, a
// failure part-way exited 0 and the surface silently served a partial corpus — while the READ path
// (EOP hydrate) already refused on a row-count mismatch. Same standard on the destructive side.
test('assertShippedCounts passes when the target holds exactly what was shipped', () => {
  assert.doesNotThrow(() =>
    assertShippedCounts({ persons: 3, interest_links: 2 }, { persons: 3, interest_links: 2 }),
  );
});

test('assertShippedCounts fails on a short table and names the numbers', () => {
  assert.throws(
    () => assertShippedCounts({ persons: 3, interest_links: 2 }, { persons: 3, interest_links: 1 }),
    (e) =>
      /interest_links: shipped 2, target has 1/.test(e.message) &&
      /verification FAILED/.test(e.message),
  );
});

test('assertShippedCounts fails closed when the read-back returned nothing', () => {
  assert.throws(
    () => assertShippedCounts({ persons: 3 }, {}),
    /persons: shipped 3, target has no answer/,
  );
});

test('assertShippedCounts ignores tables the ship skipped as absent', () => {
  assert.doesNotThrow(() =>
    assertShippedCounts({ persons: 1, gone: 'absent (skipped)' }, { persons: 1 }),
  );
});

// These drive the REAL ship path, not the helpers in isolation. That distinction is the whole point:
// with the previous shape — helpers unit-tested, main() calling them — reverting the call site to one
// request per table, and deleting the verification line outright, BOTH left the suite fully green.
const shipHarness = (over = {}) => {
  const calls = [];
  const naps = [];
  const source = over.source ?? {
    persons: { rowCount: 5, statements: ['A;', 'B;', 'C;', 'D;', 'E;'] },
    declarations: { rowCount: 1, statements: ['F;'] },
  };
  const opts = {
    tables: over.tables ?? ['persons', 'declarations'],
    readTable: (t) => source[t] ?? null,
    wipeSql: 'DELETE FROM persons;',
    apply: (name, sql) => calls.push([name, sql]),
    sleep: (ms) => naps.push(ms),
    readCounts: over.readCounts ?? ((expected) => ({ ...expected })),
    maxStatements: over.maxStatements ?? 2,
    paceMs: 500,
  };
  return { calls, naps, run: () => runShip(opts) };
};

test('runShip wipes, then ships every table in request-sized chunks, in order', () => {
  const h = shipHarness();
  const summary = h.run();

  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['0_wipe', 'persons.1', 'persons.2', 'persons.3', 'declarations'],
    'wipe first, chunks numbered so a failed request is identifiable, single-chunk table stays bare',
  );
  assert.deepEqual(
    h.calls.map(([, sql]) => sql),
    ['DELETE FROM persons;', 'A;B;', 'C;D;', 'E;', 'F;'],
  );
  assert.deepEqual(summary, { persons: 5, declarations: 1 });
});

// THE regression this exists to prevent: the counter used to restart per table, so every table
// boundary — including wipe → first insert, the most destructive transition in the run — was unpaced.
test('runShip paces every request boundary, including wipe → first insert', () => {
  const h = shipHarness();
  h.run();
  assert.equal(h.calls.length, 5);
  assert.deepEqual(
    h.naps,
    [500, 500, 500, 500],
    'one gap between each pair of requests: none before the first, none after the last, and none skipped at a table boundary',
  );
});

test('runShip verifies what landed — a short table fails the run', () => {
  const h = shipHarness({ readCounts: (expected) => ({ ...expected, persons: 4 }) });
  assert.throws(() => h.run(), /ship verification FAILED[\s\S]*persons: shipped 5, target has 4/);
});

test('runShip fails the run when the read-back itself could not answer', () => {
  const h = shipHarness({ readCounts: () => ({}) });
  assert.throws(() => h.run(), /no answer/);
});

test('runShip skips a table absent from the work DB without shipping or verifying it', () => {
  const h = shipHarness({ tables: ['persons', 'declarations', 'ghost'] });
  const summary = h.run();
  assert.equal(summary.ghost, 'absent (skipped)');
  assert.ok(
    !h.calls.some(([name]) => name.startsWith('ghost')),
    'an absent table must issue no request',
  );
});
