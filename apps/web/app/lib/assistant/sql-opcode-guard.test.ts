/// <reference types="node" />
// EXPLAIN-opcode guard tests (spec §9.4, G2 Part B) — proves the opcode allowlist against REAL bytecode
// plans, not hand-faked lists. We compile the real migration schema into an in-process SQLite
// (node:sqlite, Node 26 built-in) and EXPLAIN each statement to harvest its actual VDBE opcodes.
//
// The discriminator is empirical, not assumed: read-only queries that materialise an EPHEMERAL btree
// (DISTINCT / UNION / IN-subquery / a CTE referenced twice) legitimately emit `Insert`, `IdxInsert`,
// `NewRowid` and `Delete` against that throwaway btree — so a denylist of those would FALSE-DENY valid
// reads (asserted below). The reliable write signal is the persistent-write / DDL / vtab-write GATEWAY
// opcodes (OpenWrite, Destroy, CreateBtree, SetCookie, ParseSchema, VUpdate, VBegin, …) which never
// appear in any read plan. Hence the guard is a DEFAULT-DENY ALLOWLIST keyed by opcode NAME.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertReadOnlySelect } from './sql-guard';
import { guardSelect } from './sql-ast-guard';
import { CANONICAL_QUERIES } from './describe-schema';
import {
  assertReadOnlyPlan,
  guardOpcodes,
  KNOWN_WRITE_OPCODES,
  READ_ONLY_OPCODES,
  type ExplainRow,
} from './sql-opcode-guard';

// The SQLite versions the allowlist was harvested against. node:sqlite bundles its own SQLite, which
// differs by Node version: 3.53.2 on Node 26 (local dev) and 3.51.3 on Node 22 (CI) — and the two emit
// slightly different read-opcode universes for the same query. READ_ONLY_OPCODES is the UNION across
// these. This set is a drift tripwire: if a Node bump introduces an UNKNOWN SQLite version, this test
// fails and the opcode harvest must be re-run (a new optimisation could emit an opcode the allowlist has
// never seen → fail-closed deny in production). A query's opcodes are still validated by the SUBSET test.
// 3.53.0 ships on Node 24 (engines is ">=22", so contributors land here): a patch below the 3.53.2 we
// already cover and proven by the SUBSET test to emit no opcode outside the allowlist — so a hard version
// failure there is spurious. It is listed explicitly rather than range-matched to keep the tripwire exact.
const KNOWN_SQLITE_VERSIONS: ReadonlySet<string> = new Set(['3.53.2', '3.53.0', '3.51.3']);

let db: DatabaseSync;

beforeAll(() => {
  // Resolve the real schema relative to THIS test file: apps/web/app/lib/assistant → repo root is 5 up.
  const schemaUrl = new URL('../../../../../packages/db/migrations/0000_init.sql', import.meta.url);
  const schema = readFileSync(schemaUrl, 'utf8');
  db = new DatabaseSync(':memory:');
  db.exec(schema);
});

afterAll(() => {
  db.close();
});

/** Real VDBE opcodes for a statement, via EXPLAIN against the compiled schema. */
function explainOpcodes(sql: string): ExplainRow[] {
  return db.prepare('EXPLAIN ' + sql).all() as unknown as ExplainRow[];
}

// Representative adversarial READS — every one is read-only but exercises a construct that materialises
// an ephemeral btree or hits the FTS5 virtual table, the cases most likely to look "write-ish".
const ADVERSARIAL_READS: string[] = [
  "SELECT title FROM search_index WHERE search_index MATCH 'софия' LIMIT 5",
  'SELECT group_concat(name) AS names FROM authorities LIMIT 500',
  'SELECT quote(name) AS q, hex(name) AS h FROM authorities LIMIT 5',
  'SELECT id FROM contracts UNION SELECT id FROM tenders LIMIT 500',
  'SELECT id FROM contracts INTERSECT SELECT tender_id FROM contracts LIMIT 500',
  'SELECT id FROM contracts EXCEPT SELECT tender_id FROM contracts LIMIT 500',
  'SELECT DISTINCT bidder_id FROM contracts LIMIT 500',
  'SELECT name FROM authorities WHERE id IN (SELECT authority_id FROM tenders) LIMIT 500',
  'SELECT name FROM authorities WHERE id NOT IN (SELECT authority_id FROM tenders) LIMIT 500',
  'WITH x AS (SELECT bidder_id, SUM(amount_eur) s FROM contracts GROUP BY bidder_id) SELECT a.bidder_id FROM x a JOIN x b ON a.bidder_id = b.bidder_id LIMIT 5',
  'SELECT * FROM (SELECT bidder_id, SUM(amount_eur) s FROM contracts GROUP BY bidder_id) ORDER BY s DESC LIMIT 10',
];

// Read-only SCALAR coverage — arithmetic, comparison, logical, string, date and aggregate opcodes a
// real analytics query emits. These belong to the read-opcode universe just as much as the joins do.
const SCALAR_READS: string[] = [
  'SELECT amount + amount_eur AS a, amount - amount_eur AS b, amount * 2 AS c, amount / 2 AS d, CAST(amount AS INTEGER) % 7 AS e FROM contracts WHERE amount > 1 AND amount < 1e9 OR amount_eur >= 0 LIMIT 5',
  'SELECT * FROM contracts WHERE amount_eur <= 100 AND bids_received <> 0 AND NOT (eu_funded IS NULL) LIMIT 5',
  "SELECT upper(name) || '-' || lower(name) AS x, substr(name, 1, 3), length(name), trim(name) FROM authorities WHERE name LIKE '%а%' AND name GLOB 'А*' AND id BETWEEN 'a' AND 'z' AND region IN ('BG411', 'BG412') LIMIT 5",
  "SELECT COALESCE(amount_eur, 0), ifnull(currency, 'x'), nullif(amount, 0), abs(amount), round(amount_eur, 2), typeof(amount), CAST(amount AS TEXT) FROM contracts LIMIT 5",
  'SELECT MIN(amount_eur), MAX(amount_eur), AVG(amount_eur), total(amount_eur), COUNT(DISTINCT bidder_id) FROM contracts',
  "SELECT CASE WHEN amount_eur IS NULL THEN 'n' WHEN amount_eur > 100 THEN 'big' ELSE 'small' END, CASE currency WHEN 'BGN' THEN 1 ELSE 0 END FROM contracts LIMIT 5",
  'SELECT name FROM authorities ORDER BY name COLLATE NOCASE DESC LIMIT 5',
  "SELECT date(signed_at), strftime('%Y', signed_at), julianday(signed_at) FROM contracts WHERE signed_at IS NOT NULL LIMIT 5",
];

// Write / DDL / vtab-write statements — each MUST trip the guard. `gateway` is a KNOWN_WRITE opcode the
// plan is asserted to contain, proving the rejection rests on a real persistent-write signal (the guard
// itself rejects on the FIRST out-of-allowlist opcode, which may be an earlier write helper like RowSetAdd
// — so we assert the gateway is in the PLAN, not necessarily in the reason string).
const WRITE_STATEMENTS: { sql: string; gateway: string }[] = [
  { sql: 'UPDATE contracts SET amount_eur = 0', gateway: 'OpenWrite' },
  { sql: 'DELETE FROM contracts', gateway: 'OpenWrite' },
  { sql: "INSERT INTO authorities(id, name) VALUES('x', 'y')", gateway: 'OpenWrite' },
  { sql: 'DROP TABLE contracts', gateway: 'DropTable' },
  { sql: 'CREATE TABLE z(a)', gateway: 'CreateBtree' },
  {
    sql: "INSERT INTO search_index(kind, ref, title, ident) VALUES('a', 'b', 'c', 'd')",
    gateway: 'VUpdate',
  },
  { sql: "UPDATE search_index SET title = 'x'", gateway: 'VUpdate' },
];

describe('version pin', () => {
  it('runs against a SQLite the allowlist was harvested from (drift tripwire)', () => {
    const row = db.prepare('select sqlite_version() as v').get() as { v: string };
    expect(
      KNOWN_SQLITE_VERSIONS.has(row.v),
      `unknown SQLite ${row.v}: re-harvest the opcode allowlist and add the version to KNOWN_SQLITE_VERSIONS`,
    ).toBe(true);
  });
});

describe('guardOpcodes — real plans', () => {
  it('accepts every canonical query (mirrors the production two-layer pipeline)', () => {
    for (const q of CANONICAL_QUERIES) {
      const structural = assertReadOnlySelect(q.sql);
      expect(structural.ok, q.intent).toBe(true);
      if (!structural.ok) continue;
      const bounded = guardSelect(structural.sql);
      expect(bounded.ok, q.intent).toBe(true);
      if (!bounded.ok) continue;
      const verdict = guardOpcodes(explainOpcodes(bounded.sql));
      expect(verdict.ok, q.intent).toBe(true);
    }
  });

  it('accepts adversarial reads that materialise ephemeral btrees / hit FTS5', () => {
    for (const sql of ADVERSARIAL_READS) {
      const verdict = guardOpcodes(explainOpcodes(sql));
      expect(verdict.ok, sql).toBe(true);
    }
  });

  it('accepts read-only scalar / aggregate / date constructs', () => {
    for (const sql of SCALAR_READS) {
      const verdict = guardOpcodes(explainOpcodes(sql));
      expect(verdict.ok, sql).toBe(true);
    }
  });

  it('proves the denylist trap: valid reads DO emit ephemeral-write opcodes', () => {
    // If a naive Insert/IdxInsert/NewRowid/Delete denylist were used, the guard would FALSE-DENY real
    // reads — the whole reason it is an allowlist. Prove ≥1 such ephemeral-write opcode genuinely appears
    // across the valid-read corpus, AND that each is in the allowlist (so the reads are accepted).
    const ephemeralWrites = ['Insert', 'IdxInsert', 'NewRowid', 'Delete'];
    const readUniverse = new Set<string>();
    for (const sql of ADVERSARIAL_READS) {
      for (const r of explainOpcodes(sql)) readUniverse.add(r.opcode as string);
    }
    const seen = ephemeralWrites.filter((op) => readUniverse.has(op));
    expect(
      seen.length,
      'valid reads must emit at least one ephemeral-write opcode',
    ).toBeGreaterThan(0);
    for (const op of seen) expect(READ_ONLY_OPCODES.has(op), op).toBe(true);
  });

  it('rejects every write / DDL / vtab-write statement, on a real gateway opcode', () => {
    for (const { sql, gateway } of WRITE_STATEMENTS) {
      const rows = explainOpcodes(sql);
      const verdict = guardOpcodes(rows);
      expect(verdict.ok, sql).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.reason, sql).toMatch(/non-read-only opcode/);
      // The rejection rests on a genuine persistent-write/DDL/vtab gateway present in the plan…
      expect(
        rows.some((r) => r.opcode === gateway),
        `${sql} → expected gateway ${gateway}`,
      ).toBe(true);
      expect(KNOWN_WRITE_OPCODES.has(gateway), gateway).toBe(true);
      // …and the plan carries ≥1 opcode outside the allowlist (what actually fired the deny).
      expect(
        rows.some((r) => !READ_ONLY_OPCODES.has(r.opcode as string)),
        sql,
      ).toBe(true);
    }
  });

  it('rejects an empty plan (fail closed)', () => {
    const verdict = guardOpcodes([]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('empty EXPLAIN plan');
  });

  it('rejects an unknown / future opcode (fail closed)', () => {
    const verdict = guardOpcodes([{ opcode: 'Frobnicate' }]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/non-read-only opcode in plan: Frobnicate/);
  });
});

describe('allowlist invariants', () => {
  it('the corpus opcode universe is a SUBSET of READ_ONLY_OPCODES', () => {
    // Bound the canonical queries through the real production pipeline, then EXPLAIN the bounded SQL.
    const bounded: string[] = [];
    for (const q of CANONICAL_QUERIES) {
      const structural = assertReadOnlySelect(q.sql);
      if (!structural.ok) continue;
      const lim = guardSelect(structural.sql);
      if (lim.ok) bounded.push(lim.sql);
    }
    const universe = new Set<string>();
    for (const sql of [...bounded, ...ADVERSARIAL_READS, ...SCALAR_READS]) {
      for (const row of explainOpcodes(sql)) universe.add(row.opcode as string);
    }
    const extra = [...universe].filter((op) => !READ_ONLY_OPCODES.has(op)).sort();
    expect(
      extra,
      `opcodes emitted by reads but missing from the allowlist: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('READ_ONLY_OPCODES is disjoint from KNOWN_WRITE_OPCODES', () => {
    const overlap = [...READ_ONLY_OPCODES].filter((op) => KNOWN_WRITE_OPCODES.has(op));
    expect(overlap).toEqual([]);
  });

  it('no write statement emits a KNOWN_WRITE gateway that is in the allowlist', () => {
    for (const { sql } of WRITE_STATEMENTS) {
      const ops = new Set(explainOpcodes(sql).map((r) => r.opcode as string));
      const firedGateways = [...ops].filter((op) => KNOWN_WRITE_OPCODES.has(op));
      expect(firedGateways.length, sql).toBeGreaterThan(0);
    }
  });
});

describe('assertReadOnlyPlan — D1-shaped async boundary', () => {
  // Minimal D1-like stub: prepare(sql).all() resolves { results }. The guard must accept both D1 and
  // this mock, so it is typed loosely (no D1Database import).
  function mockDb(planFor: (sql: string) => ExplainRow[] | Error) {
    return {
      prepare(sql: string) {
        return {
          all<T = unknown>(): Promise<{ results?: T[] }> {
            const r = planFor(sql);
            if (r instanceof Error) return Promise.reject(r);
            return Promise.resolve({ results: r as unknown as T[] });
          },
        };
      },
    };
  }

  it('returns {ok:true, sql} for a read plan', async () => {
    const sql = 'SELECT 1';
    const db2 = mockDb(() => [{ opcode: 'Init' }, { opcode: 'ResultRow' }, { opcode: 'Halt' }]);
    const verdict = await assertReadOnlyPlan(db2, sql);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.sql).toBe(sql);
  });

  it('rejects a write plan', async () => {
    const db2 = mockDb(() => [{ opcode: 'Init' }, { opcode: 'OpenWrite' }, { opcode: 'Halt' }]);
    const verdict = await assertReadOnlyPlan(db2, 'DELETE FROM contracts');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/non-read-only opcode in plan: OpenWrite/);
  });

  it('fails closed when EXPLAIN throws', async () => {
    const db2 = mockDb(() => new Error('boom'));
    const verdict = await assertReadOnlyPlan(db2, 'SELECT 1');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('could not verify read-only execution plan');
  });
});

// Manual D1-engine verification (review #12, should-fix). The allowlist above is harvested and asserted
// only against node:sqlite; the one engine it has never seen is D1's own SQLite, which is what production
// actually EXPLAINs against. The runtime path already fails CLOSED on any unlisted opcode (assertReadOnlyPlan
// runs EXPLAIN on the live binding) — so a divergence degrades to a false-DENY, never a missed write — but
// nothing proves D1's read-opcode universe ⊆ READ_ONLY_OPCODES (or even that D1 returns opcode rows via
// .all()). This block captures exactly that, one-off, against a REAL D1. It is SKIPPED by default so CI
// never depends on remote D1 credentials/latency. Run it manually after a Node bump or guard change:
//
//   VERIFY_D1_OPCODES=1 D1_DATABASE_NAME=sigma pnpm exec vitest run \
//     --config vitest.config.ts app/lib/assistant/sql-opcode-guard.test.ts
//
// (Add `--remote` semantics by default; set D1_LOCAL=1 to EXPLAIN against the local .wrangler D1 instead.)
const RUN_D1_VERIFY = process.env.VERIFY_D1_OPCODES === '1';
describe.skipIf(!RUN_D1_VERIFY)('D1 engine opcode verification (manual)', () => {
  function d1Explain(sql: string): string[] {
    const dbName = process.env.D1_DATABASE_NAME ?? 'sigma';
    const location = process.env.D1_LOCAL === '1' ? '--local' : '--remote';
    // execFileSync (no shell) so multi-token SQL needs no quoting; collapse newlines for the --command arg.
    const out = execFileSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'execute',
        dbName,
        location,
        '--json',
        '--command',
        `EXPLAIN ${sql.replace(/\s+/g, ' ').trim()}`,
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const json = JSON.parse(out.slice(out.indexOf('['))) as Array<{
      results?: { opcode?: string }[];
    }>;
    const rows = json[0]?.results ?? [];
    return rows.map((r) => r.opcode).filter((op): op is string => typeof op === 'string');
  }

  it('every read opcode D1 emits for the corpus is in READ_ONLY_OPCODES', () => {
    const bounded: string[] = [];
    for (const q of CANONICAL_QUERIES) {
      const structural = assertReadOnlySelect(q.sql);
      if (!structural.ok) continue;
      const lim = guardSelect(structural.sql);
      if (lim.ok) bounded.push(lim.sql);
    }
    const universe = new Set<string>();
    for (const sql of [...bounded, ...ADVERSARIAL_READS, ...SCALAR_READS]) {
      for (const op of d1Explain(sql)) universe.add(op);
    }
    // D1 must actually return opcode rows via .all() — if it returns none, the runtime L3 guard is a no-op.
    expect(universe.size, 'D1 returned no EXPLAIN opcode rows via .all()').toBeGreaterThan(0);
    const extra = [...universe].filter((op) => !READ_ONLY_OPCODES.has(op)).sort();
    expect(extra, `D1 emits read opcodes outside the allowlist: ${extra.join(', ')}`).toEqual([]);
  });
});
