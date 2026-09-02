// A tripwire on the SHAPE of refresh-slice.sql, not on its results.
//
// On 2026-08-14 the `amendments` batch began failing on D1 with `out of memory: SQLITE_NOMEM` and kept
// failing every six hours for nineteen days. The data was not at fault — it OOMed even when the slice
// matched zero rows — and neither was raw size: the two biggest statements in the `contracts` batch
// (349 and 363 lines) run fine, while the one that died was 308.
//
// What it was: a large `UPDATE … FROM <cte>`. SQLite is free to flatten an unhinted CTE rather than
// materialise it, and the old statement's local plan indeed shows no MATERIALIZE node — so the honest
// description is not "SQLite must materialise the chain" but "the planner's expansion of this shape, at
// this size, exceeded what D1 would allocate". Splitting the heavy half into a real table acts as an
// optimisation fence and keeps the surviving statement small.
//
// The failure was invisible from outside: `@refresh-batch setup` NULLs home_totals.as_of and only
// `globals` restores it, so a death in between leaves the surface with no freshness marker at all
// rather than an error anyone would notice.
//
// LIMITS OF THIS TEST, stated plainly: it reads SQL with regexes. It catches the shape in the forms
// we have seen or would routinely write — a bare name, `FROM x alias`, `FROM x AS a`, `FROM x JOIN …`,
// quoted names, column-list CTEs, `WITH RECURSIVE`, `AS [NOT] MATERIALIZED (`. It does NOT catch: a
// `FROM` that is not at the start of its line, a CTE reached only from the right-hand side of a JOIN,
// or a derived-table source (`FROM (SELECT …)`); and it strips `--` comments but not `/* … */` blocks,
// so a block comment still counts toward the line threshold. Extend the patterns before relying on
// any of those. It cannot prove a statement fits D1's budget. It is a tripwire against drift, not a
// proof of safety.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshSliceStatementGroups } from './refresh';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL = readFileSync(join(ROOT, 'scripts/refresh-slice.sql'), 'utf8');

/** Statement text with comments and blank lines removed — so prose cannot move a size threshold. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** CTE names introduced by `WITH x AS (`, `WITH RECURSIVE x AS (`, `), y AS (`, incl. column lists. */
function cteNames(sql: string): Set<string> {
  const re =
    /(?:^\s*WITH(?:\s+RECURSIVE)?|\)\s*,)\s*"?([a-z_][a-z0-9_]*)"?\s*(?:\([^)]*\))?\s+AS\s*(?:MATERIALIZED\s+|NOT\s+MATERIALIZED\s+)?\(/gim;
  return new Set([...sql.matchAll(re)].flatMap((m) => (m[1] ? [m[1].toLowerCase()] : [])));
}

/**
 * Does this UPDATE take rows from one of its own CTEs? Covers `FROM x`, `FROM x alias`, `FROM x AS a`
 * and `FROM x JOIN …` — the forms a routine edit would produce. A derived-table source (`FROM (SELECT …)`)
 * is deliberately not matched: it is a different shape and has not been observed here.
 */
function updatesFromOwnCte(sql: string): string[] {
  if (!/^\s*UPDATE\b/im.test(sql)) return [];
  const ctes = cteNames(sql);
  return [...sql.matchAll(/^\s*FROM\s+"?([a-z_][a-z0-9_]*)"?\b/gim)]
    .flatMap((m) => (m[1] ? [m[1].toLowerCase()] : []))
    .filter((name) => ctes.has(name));
}

describe('refresh-slice statement shape', () => {
  it('keeps every UPDATE … FROM <cte> small enough that the planner survived it', () => {
    // The band is measured, not guessed — all three points observed on this file:
    // (code lines = comments and blank lines stripped, exactly as `code()` below counts them):
    //   lot-values  ·  30 code lines ·  1 nested SELECT  · runs fine (since 2026-06)
    //   amendments  · 105 code lines ·  5 nested SELECTs · runs fine (after this split)
    //   amendments  · 247 code lines · 19 nested SELECTs · OOMed D1 for nineteen days
    const offenders = refreshSliceStatementGroups(SQL)
      .flatMap((g) => g.statements.map((sql) => ({ group: g.name, sql })))
      .filter(({ sql }) => updatesFromOwnCte(sql).length > 0)
      .map(({ group, sql }) => {
        const body = code(sql);
        return {
          group,
          lines: body.split('\n').length,
          subqueries: (body.match(/\(\s*SELECT\b/gi) ?? []).length,
        };
      })
      .filter((s) => s.lines > 160 || s.subqueries > 12);

    expect(
      offenders,
      'An `UPDATE … FROM <cte>` in refresh-slice.sql has grown back past the size that exhausted D1 on\n' +
        '2026-08-14 (SQLITE_NOMEM, nineteen days of silent staleness). Move the heavy half into a\n' +
        'transient table first, the way amend_contract_base does, rather than raising these numbers.',
    ).toEqual([]);
  });

  it('materialises contract_base, and the consumer reads the table it creates', () => {
    expect(SQL).not.toMatch(/^WITH contract_base AS \(/m);
    const create = SQL.indexOf('CREATE TABLE amend_contract_base AS');
    const read = SQL.indexOf('FROM amend_contract_base');
    expect(create, 'the transient table is no longer created').toBeGreaterThan(-1);
    expect(read, 'nothing reads amend_contract_base — the split lost its consumer').toBeGreaterThan(
      create,
    );
  });

  it('guards the transient table on both sides of its use, in order', () => {
    const create = SQL.indexOf('CREATE TABLE amend_contract_base AS');
    const drops = [...SQL.matchAll(/DROP TABLE IF EXISTS amend_contract_base\b/g)].map(
      (m) => m.index,
    );
    expect((SQL.match(/CREATE TABLE amend_contract_base\b/g) ?? []).length).toBe(1);
    // one before the CREATE (so a re-run cannot read a stale slice) and one after the consumer
    expect(drops.filter((i) => i < create)).toHaveLength(1);
    expect(drops.filter((i) => i > SQL.indexOf('FROM amend_contract_base'))).toHaveLength(1);
  });

  it('registers the transient table so an aborted run is swept', () => {
    // Without this, a run that dies between CREATE and DROP leaves the table in D1 until the next
    // refresh happens to reach its DROP — exactly the kind of silent residue this batch already bit us with.
    const refreshTs = readFileSync(join(ROOT, 'packages/ingest/src/refresh.ts'), 'utf8');
    expect(refreshTs).toMatch(/SCRATCH_TABLES\s*=\s*\[[^\]]*'amend_contract_base'/);
  });
});
