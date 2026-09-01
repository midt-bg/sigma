import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANONICAL_QUERIES, TABLES } from '../app/lib/assistant/describe-schema';

// Drift guard: the data dictionary the model reads (describe-schema.ts TABLES/CANONICAL_QUERIES)
// is pinned against the REAL served schema — packages/db/migrations/*.sql applied in order to a
// throwaway sqlite3 database, then checked via pragma_table_info. The dictionary drifted silently
// once before (`amendments.contract_id` never existed; found only by eye in review #321): every
// phantom column here is handed to the model in every prompt, and the resulting SQL fails at run
// time with an error the model may "fix" by guessing another wrong column. This suite makes the
// next such drift a red build instead.
//
// Runs the same way as packages/db/src/migrations.test.ts: the `sqlite3` CLI (present on the CI
// runner and any dev machine with the repo's toolchain). It deliberately applies ALL migrations,
// so a future migration that renames or drops a dictionary-listed column fails here immediately.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/db/migrations/', import.meta.url));

let workDir: string;
let dbPath: string;

function sql(query: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: query, encoding: 'utf8' });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sigma-schema-drift-'));
  dbPath = join(workDir, 'served.sqlite');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    execFileSync('sqlite3', ['-bail', dbPath], {
      input: readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
      encoding: 'utf8',
    });
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Real column names of a table/virtual table in the migrated schema. */
function columnsOf(table: string): Set<string> {
  return new Set(
    sql(`SELECT name FROM pragma_table_info('${table}');`)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * The bare column identifiers a dictionary `columns` string names: the leading ASCII identifier of
 * each TOP-LEVEL comma-separated segment. Parenthesised notes (which may contain commas, quotes and
 * cross-table references) are ignored, as are pure-prose segments like the `…` ellipsis.
 */
function dictionaryColumns(columns: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < columns.length; i += 1) {
    const ch = columns[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      segments.push(columns.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(columns.slice(start));
  // Fail LOUDLY on an unbalanced entry: after an unclosed '(' no top-level comma is ever seen
  // again, so every later column would silently fall out of the guard — the exact failure mode
  // this suite exists to prevent would then hide inside the suite itself.
  if (depth !== 0) throw new Error(`unbalanced parentheses in dictionary columns: ${columns}`);
  return (
    segments
      // Strip a SQL quoting wrapper first (`"col"`, `[col]`, `` `col` ``): the identifier regex below
      // starts at a letter/underscore, so a quoted top-level column would otherwise be silently skipped
      // and never checked against the real schema — a guard that fails OPEN. The dictionary does not
      // quote today; this keeps the guard closed if it ever does (review f/u, ydimitrof).
      .map((s) => s.trim().replace(/^["'`[]+/, ''))
      .map((s) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(s)?.[0])
      .filter((c): c is string => c !== undefined)
  );
}

/** The `→target` table references a dictionary `columns` string names (e.g. `tender_id→tenders`). */
function dictionaryRefs(columns: string): string[] {
  return [...columns.matchAll(/→([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? '');
}

describe('describe-schema drift guard (dictionary vs the migrated schema)', () => {
  it('every dictionary table exists in the served schema', () => {
    const real = new Set(
      sql("SELECT name FROM sqlite_master WHERE type IN ('table', 'view');")
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const missing = TABLES.map((t) => t.name).filter((name) => !real.has(name));
    expect(missing).toEqual([]);
  });

  it('every bare column identifier in every dictionary entry exists on its table', () => {
    const missing: string[] = [];
    for (const t of TABLES) {
      const real = columnsOf(t.name);
      for (const col of dictionaryColumns(t.columns)) {
        if (!real.has(col)) missing.push(`${t.name}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every →table reference in a dictionary entry names a real table', () => {
    const real = new Set(
      sql("SELECT name FROM sqlite_master WHERE type IN ('table', 'view');")
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const refs = TABLES.flatMap((t) => dictionaryRefs(t.columns).map((r) => `${t.name}: →${r}`));
    // Anti-vacuity: the dictionary DOES use →refs today (tenders is referenced), so an extraction
    // that silently dies (e.g. the arrows get normalised to ASCII '->') fails here instead of
    // making the assertion below pass on an empty list forever.
    expect(refs.join(' ')).toContain('→tenders');
    const missing = refs.filter((r) => !real.has(r.split('→')[1] ?? ''));
    expect(missing).toEqual([]);
  });

  it('every canonical example query COMPILES against the migrated schema (EXPLAIN)', () => {
    // EXPLAIN only compiles — no data needed. A canonical query naming a phantom column is worse
    // than a dictionary typo: the model copies these verbatim as its starting point.
    for (const q of CANONICAL_QUERIES) {
      try {
        sql(`EXPLAIN ${q.sql}`);
      } catch (e) {
        throw new Error(
          `canonical query "${q.intent}" does not compile against the migrations: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  });

  it('NEGATIVE CONTROL: the guard flags the historic drift it exists to catch', () => {
    // main carried `amendments: 'id, contract_id→contracts, …'` for the file's whole life —
    // contract_id never existed. The parser must surface exactly that (and skip the `…` prose).
    const historic = 'id, contract_id→contracts, …';
    expect(dictionaryColumns(historic)).toEqual(['id', 'contract_id']);
    const real = columnsOf('amendments');
    expect(real.has('id')).toBe(true);
    expect(real.has('contract_id')).toBe(false);
  });

  it('NEGATIVE CONTROL: the parser respects parenthesised notes with commas and cross-table refs', () => {
    expect(
      dictionaryColumns(
        "amount (display, в `currency`), value_delta (за EUR ползвай contracts.amount_eur, не това), facet ('year'|'eu'), …, key",
      ),
    ).toEqual(['amount', 'value_delta', 'facet', 'key']);
    // →refs inside a NOTE are still refs (they name tables and must stay real); the leading-identifier
    // rule and the ref rule are independent extractions over the same string.
    expect(dictionaryRefs('tender_id→tenders, x (виж и bidder_id→bidders)')).toEqual([
      'tenders',
      'bidders',
    ]);
  });

  it('NEGATIVE CONTROL: an unbalanced dictionary entry fails loudly instead of exempting its tail', () => {
    // With an unclosed '(' the parser would otherwise never see another top-level comma, silently
    // dropping every later column from the guard.
    expect(() =>
      dictionaryColumns('id, amount (display, в `currency`, value_delta, currency'),
    ).toThrow(/unbalanced/);
  });
});
