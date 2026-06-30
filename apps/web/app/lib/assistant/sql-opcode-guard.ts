// EXPLAIN-opcode read-only guard (spec §9.4, G2 Part B) — the THIRD, runtime layer that wraps the
// structural (sql-guard.ts) and AST (sql-ast-guard.ts) guards. Those two prove a statement is a single
// read-only SELECT over allowlisted tables BEFORE execution; this one verifies the EXECUTION PLAN the
// database actually compiled is read-only, closing the residual gap that a parser miss could leave a
// write running against the read-write D1 binding (spec §9.4, still-open data-path note in sql-guard.ts).
//
// HOW: `EXPLAIN <sql>` returns the VDBE bytecode SQLite will run — one row per instruction, each with an
// `opcode` name. We check every opcode against a DEFAULT-DENY ALLOWLIST; anything outside it (including
// an opcode a future SQLite invents) fails closed.
//
// WHY AN ALLOWLIST, NOT A DENYLIST — the non-obvious part, established empirically against the real
// schema: read-only queries that materialise an EPHEMERAL btree (DISTINCT, UNION/INTERSECT/EXCEPT, an
// IN-subquery, a CTE referenced twice) legitimately emit `Insert`, `IdxInsert`, `NewRowid` and `Delete`
// against that throwaway btree. A denylist of those names would FALSE-DENY valid reads. The reliable
// write discriminator is instead the PERSISTENT-write / DDL / vtab-write GATEWAY opcodes — `OpenWrite`,
// `Destroy`, `CreateBtree`, `SetCookie`, `ParseSchema`, `VUpdate`, `VBegin`, … — none of which appear in
// any read plan. So the allowlist is the harvested read-opcode universe (which INCLUDES the ephemeral
// writes); the gateways sit outside it and trip the guard. Opcode NAMES are version-stable across SQLite
// releases; numeric codes are not — so we key on the name. The allowlist is a UNION (superset) across the
// SQLite versions we run against — 3.53.2 (node:sqlite/Node 26, local) and 3.51.3 (Node 22, CI) emit
// slightly different read-opcode universes for the same query (e.g. 3.51.3 adds Blob/Close/FilterAdd/
// IdxDelete/NotFound/RowData). Production EXPLAINs against D1's own SQLite (a third version) — keeping the
// allowlist a name-keyed superset minimises false-denials there while a missing opcode still fails CLOSED.
// The test asserts the live SQLite is one of the KNOWN versions (drift tripwire) and that the corpus opcode
// universe is a subset of this allowlist.
//
// D1-ENGINE COVERAGE (review #12). The allowlist is harvested and unit-tested only on node:sqlite; D1's own
// SQLite is the one engine it has not been measured against. This is sound because the RUNTIME path
// (`assertReadOnlyPlan`, called by run_sql) EXPLAINs against the LIVE D1 binding and fails CLOSED on any
// unlisted opcode — so an unseen D1 read opcode degrades to a false-DENY of a legitimate read, never a
// missed write. To confirm the allowlist actually covers D1 (no spurious denials) there is a manual,
// skipped-by-default verification in sql-opcode-guard.test.ts → "D1 engine opcode verification": it
// EXPLAINs the canonical+adversarial corpus against a real D1 and asserts the opcode universe ⊆ this set.
// Run it after a Node bump or guard change (it is kept out of CI to avoid remote-D1 credentials/latency):
//   VERIFY_D1_OPCODES=1 D1_DATABASE_NAME=sigma pnpm exec vitest run app/lib/assistant/sql-opcode-guard.test.ts

import type { GuardResult } from './sql-guard';

/** One EXPLAIN output row. D1 and node:sqlite both key it by these column names; only `opcode` is read. */
export interface ExplainRow {
  addr?: number;
  opcode?: string | null;
  p1?: number;
  p2?: number;
  p3?: number;
  p4?: unknown;
  p5?: number;
  comment?: string | null;
}

// The read-opcode universe — harvested by EXPLAIN-ing the canonical query corpus plus adversarial reads
// (FTS5 MATCH, set ops, DISTINCT, IN/NOT-IN subqueries, twice-referenced CTEs) and read-only scalar /
// aggregate / date constructs against the real migration schema. Alphabetised. Deliberately INCLUDES the
// ephemeral-btree write opcodes (Delete, IdxInsert, Insert, NewRowid) that valid reads emit — that is the
// whole reason this is an allowlist and not a denylist (see header). Anything not listed → fail-closed.
export const READ_ONLY_OPCODES: ReadonlySet<string> = new Set([
  'Add',
  'Affinity',
  'AggFinal',
  'AggStep',
  'BeginSubrtn',
  'Blob', // load a blob/text value into a register — read (SQLite 3.51.3 / Node 22)
  'Cast',
  'Close', // close a cursor — read (SQLite 3.51.3 / Node 22)
  'CollSeq',
  'Column',
  'Compare',
  'Concat',
  'Copy',
  'DecrJumpZero',
  'DeferredSeek',
  'Delete', // ephemeral-btree clear during read materialisation (NOT a persistent delete — gated by OpenWrite)
  'Divide',
  'EndCoroutine',
  'Eq',
  'FilterAdd', // add a key to a Bloom filter for a join probe — read (SQLite 3.51.3 / Node 22)
  'Found',
  'Function',
  'Gosub',
  'Goto',
  'Halt',
  'IdxDelete', // ephemeral/auto-index entry removal during DISTINCT/UNION dedup — read-only (gated by OpenWrite)
  'IdxGT',
  'IdxInsert', // ephemeral/auto index build during DISTINCT/UNION/IN — read-only
  'IdxLE',
  'If',
  'IfEmpty',
  'IfNot',
  'IfNotZero',
  'IfPos',
  'Init',
  'InitCoroutine',
  'Insert', // ephemeral-table populate for a materialised subquery/CTE — read-only (no OpenWrite cursor)
  'Integer',
  'IsNull',
  'Jump',
  'Last',
  'Le',
  'Lt',
  'MakeRecord',
  'Move',
  'Multiply',
  'Ne',
  'NewRowid', // rowid for an ephemeral-table row — read-only
  'Next',
  'Noop',
  'NotFound', // seek that jumps when a key is absent — read (SQLite 3.51.3 / Node 22)
  'NotNull',
  'Null',
  'NullRow',
  'Once',
  'OpenAutoindex',
  'OpenDup',
  'OpenEphemeral',
  'OpenPseudo',
  'OpenRead',
  'Real',
  'RealAffinity',
  'Remainder',
  'ResultRow',
  'Return',
  'Rewind',
  'RowData', // read the full row payload of the current cursor — read (SQLite 3.51.3 / Node 22)
  'Rowid',
  'SCopy',
  'SeekGE',
  'SeekGT',
  'Sequence',
  'Sort',
  'SorterData',
  'SorterInsert',
  'SorterNext',
  'SorterOpen',
  'SorterSort',
  'String8',
  'Subtract',
  'Transaction', // EXPLAIN emits a (read) Transaction op even for a SELECT; the write signal is OpenWrite, not this
  'VColumn',
  'VFilter',
  'VNext',
  'VOpen', // read side of a virtual table (FTS5 MATCH) — the write side is VUpdate/VBegin, which are denied
  'Yield',
]);

// Documentation / invariant set: the GATEWAY opcodes that unambiguously mark a persistent write, DDL, or
// virtual-table mutation. Used by tests to assert disjointness from the allowlist and to confirm every
// write statement trips at least one of these. DELIBERATELY EXCLUDES Insert/Delete/IdxInsert/NewRowid —
// those are AMBIGUOUS (emitted by ephemeral-btree reads too) and are gated by OpenWrite/VUpdate, not
// trusted on their own. This set is not consulted by guardOpcodes (which is a pure allowlist); it exists
// so the test suite can prove the allowlist and the write universe stay disjoint.
export const KNOWN_WRITE_OPCODES: ReadonlySet<string> = new Set([
  'Clear', // truncate a btree
  'CreateBtree', // CREATE TABLE/INDEX
  'Destroy', // DROP — destroy a btree
  'DropIndex',
  'DropTable',
  'DropTrigger',
  'OpenWrite', // a writable cursor on a persistent table — the canonical write signal
  'ParseSchema', // schema mutation re-parse (DDL)
  'SetCookie', // bump the schema cookie (DDL)
  'VBegin', // begin a virtual-table write
  'VCreate', // CREATE VIRTUAL TABLE
  'VDestroy', // DROP a virtual table
  'VRename', // ALTER a virtual table name
  'VUpdate', // virtual-table INSERT/UPDATE/DELETE (FTS5 writes)
  'Vacuum',
]);

/**
 * Pure verdict over a list of EXPLAIN rows: read-only iff EVERY opcode is in the allowlist. Fails closed
 * on an empty plan and on the first opcode outside the allowlist (naming it), including a null/unknown one.
 */
export function guardOpcodes(rows: readonly ExplainRow[]): GuardResult {
  if (!rows.length) return { ok: false, reason: 'empty EXPLAIN plan' };
  for (const row of rows) {
    const op = row.opcode;
    if (typeof op === 'string' && READ_ONLY_OPCODES.has(op)) continue;
    return { ok: false, reason: `non-read-only opcode in plan: ${op ?? '(missing)'}` };
  }
  return { ok: true, sql: '' };
}

/**
 * Runtime check: EXPLAIN `sql` on the live binding and verify the compiled plan is read-only. `db` is typed
 * loosely so it accepts both a D1Database and a test mock (no D1 type import). Returns `{ok:true, sql}` so a
 * caller can chain the verified SQL; fails closed — any throw (bad SQL, binding error) is treated as
 * "unverifiable", never as a pass.
 */
export async function assertReadOnlyPlan(
  db: { prepare(sql: string): { all<T = unknown>(): Promise<{ results?: T[] }> } },
  sql: string,
): Promise<GuardResult> {
  try {
    const res = await db.prepare('EXPLAIN ' + sql).all<ExplainRow>();
    const verdict = guardOpcodes(res.results ?? []);
    return verdict.ok ? { ok: true, sql } : verdict;
  } catch (err) {
    console.error('assertReadOnlyPlan: could not EXPLAIN the statement', err);
    return { ok: false, reason: 'could not verify read-only execution plan' };
  }
}
