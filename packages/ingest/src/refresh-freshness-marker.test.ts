/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refreshSliceStatementGroups, splitSqlStatements } from './refresh';

// The slice refresh runs its groups as SEPARATE batches — `runRefreshSliceBatches` in scripts/import.mjs
// shells out once per group, and the Worker path calls db.batch() once per group. Nothing is
// transactional ACROSS groups, so a group that throws leaves every earlier group applied and every later
// one unrun. That is not hypothetical: a catch-up on 2026-08-23 died in `amendments` with SQLITE_NOMEM,
// leaving contracts and tenders advanced by four days while `home_totals` still advertised the previous
// slice — a date that was confidently wrong.
//
// The rule these tests hold is that what the site says about its data moves in the SAME group as the data:
// the as-of date in the group that writes the contracts, the data generation before the first group that
// writes served rows and after the last. Then there is no gap for a death to fall into, and the date is
// never NULL (it was nulled in `setup` from 2026-08 to 2026-11, which left the site with no date at all
// after an early death). The behaviour on the real Workflow is in apps/etl/src/index.test.ts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const refreshSlice = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
const precompute = readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8');
const groups = refreshSliceStatementGroups(refreshSlice);
const all = groups.flatMap((g) => g.statements.map((sql) => ({ group: g.name, sql })));

const AS_OF_UPDATE = /^UPDATE home_totals SET as_of = ([\s\S]+) WHERE id = 1$/;
const GENERATION_UPDATE = "UPDATE home_totals SET refreshed_at = datetime('now') WHERE id = 1";
const writesContracts = (sql: string) =>
  /^(?:DELETE FROM|INSERT(?: OR \w+)? INTO|REPLACE INTO|UPDATE)\s+contracts\b/i.test(sql);

/** The expression a home_totals INSERT writes into `column`, split on top-level commas. */
function homeTotalsInsertExpression(sql: string, column: string): string {
  const insert = splitSqlStatements(sql).find((s) => /^INSERT INTO home_totals\b/.test(s))!;
  const [, columns, select] = insert.match(
    /^INSERT INTO home_totals \(([^)]*)\)\s*SELECT\s+([\s\S]*)$/,
  )!;
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select!) {
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    current += ch;
  }
  items.push(current.trim());
  return items[
    columns!
      .split(',')
      .map((c) => c.trim())
      .indexOf(column)
  ]!;
}

describe('the as-of date and the generation move with the served data', () => {
  it('resolves annexes without changing served rows, then moves the generation first thing', () => {
    const [resolution, first] = groups;
    expect(resolution!.name).toBe('resolve-annexes');
    expect(resolution!.statements.join('\n')).not.toMatch(
      /(?:UPDATE|DELETE FROM|INSERT INTO|REPLACE INTO)\s+(?:amendments|contracts|tenders|data_freshness|home_totals)\b/i,
    );
    expect(first!.name).toBe('setup');
    expect(first!.statements[0]).toBe(GENERATION_UPDATE);
  });

  it('never sets the date (or anything else on the freshness rows) to NULL', () => {
    const nulling = all.filter(({ sql }) =>
      /^UPDATE\s+(?:home_totals|data_freshness)\s+SET[^;]*=\s*NULL\b/i.test(sql),
    );
    expect(nulling).toEqual([]);
  });

  it('writes the as-of date in the group that writes the contracts, and only there', () => {
    const contractWriters = [
      ...new Set(all.filter(({ sql }) => writesContracts(sql)).map((s) => s.group)),
    ];
    // The ordering-unit clean-up in `ocds-publication` and the value roll in `amendments` UPDATE
    // contracts too, but never their existence or their signing date — only `contracts` does.
    const datesOrExistence = all.filter(
      ({ sql }) =>
        /^(?:DELETE FROM|INSERT(?: OR \w+)? INTO|REPLACE INTO)\s+contracts\b/i.test(sql) ||
        (/^UPDATE\s+contracts\b/i.test(sql) && /\bsigned_at\s*=/i.test(sql)),
    );
    expect([...new Set(datesOrExistence.map((s) => s.group))]).toEqual(['contracts']);
    expect(contractWriters).toContain('contracts');

    const asOf = all.filter(({ sql }) => AS_OF_UPDATE.test(sql));
    expect(asOf.map((s) => s.group)).toEqual(['contracts']);
    // After the contract rows, in the same group: it reads what the group has just written.
    const contracts = groups.find((g) => g.name === 'contracts')!.statements;
    const lastContractWrite = contracts.reduce(
      (last, sql, i) => (writesContracts(sql) ? i : last),
      -1,
    );
    expect(contracts.findIndex((sql) => AS_OF_UPDATE.test(sql))).toBeGreaterThan(lastContractWrite);
  });

  it('computes the date with the expression the full build writes, so a refreshed and a rebuilt slot agree', () => {
    const [, expression] = all.find(({ sql }) => AS_OF_UPDATE.test(sql))!.sql.match(AS_OF_UPDATE)!;
    expect(homeTotalsInsertExpression(precompute, 'as_of')).toBe(expression);
    // `globals` rewrites the whole row and repeats the same value: no contract changes after `contracts`.
    expect(homeTotalsInsertExpression(refreshSlice, 'as_of')).toBe(expression);
  });

  it('moves the generation again in `cleanup`, the last group, after every group that writes served rows', () => {
    const last = groups[groups.length - 1]!;
    // A new batch that writes served rows goes ABOVE `cleanup`: if one is added after it, this fails.
    expect(last.name).toBe('cleanup');
    expect(last.statements[0]).toBe(GENERATION_UPDATE);
    expect(last.statements.slice(1).every((sql) => /^DROP TABLE IF EXISTS \w+$/.test(sql))).toBe(
      true,
    );
    expect(all.filter(({ sql }) => sql === GENERATION_UPDATE).map((s) => s.group)).toEqual([
      'setup',
      'cleanup',
    ]);
  });

  it('rewrites the planner watermark (data_freshness) only in `globals`, whole', () => {
    const writes = all.filter(({ sql }) =>
      /^(?:DELETE FROM|INSERT(?: OR \w+)? INTO|REPLACE INTO|UPDATE)\s+data_freshness\b/i.test(sql),
    );
    expect(writes.map((s) => s.group)).toEqual(['globals', 'globals']);
    expect(writes[0]!.sql).toBe('DELETE FROM data_freshness');
  });
});
