/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fullClearTables } from './refresh';

// fullClearTables answers one question for scripts/import.mjs: which tables does a full derive empty,
// and therefore what does a partial window destroy? The guard that used to ask it named `contracts`
// alone while the clear had reached fourteen tables — so the tests that matter here are the ones that
// keep the answer tied to the SQL rather than to a copy of it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const normalizeRaw = readFileSync(resolve(root, 'scripts/normalize-raw.sql'), 'utf8');

describe('fullClearTables', () => {
  it('reads the block out of the real normalize-raw.sql', () => {
    const tables = fullClearTables(normalizeRaw);
    // The base domain tables: whatever else the block grows, losing any of these is losing the corpus.
    expect(tables).toEqual(
      expect.arrayContaining(['contracts', 'lots', 'tenders', 'bidders', 'authorities']),
    );
  });

  it('stops before the per-run metadata resets further down the file', () => {
    // normalize-raw.sql also clears data_freshness and pipeline_stats, which are rewritten every run.
    // Counting them as corpus would make the guard refuse EVERY full derive, initial backfill included
    // — a guard that always refuses gets deleted, so this boundary is load-bearing.
    const tables = fullClearTables(normalizeRaw);
    expect(tables).not.toContain('data_freshness');
    expect(tables).not.toContain('pipeline_stats');
  });

  it('keeps the marker and the block adjacent', () => {
    // If the marker is dropped or drifts away from the DELETEs, this returns [] and import.mjs throws
    // rather than silently deciding the corpus is empty and letting the destructive path through.
    expect(fullClearTables(normalizeRaw).length).toBeGreaterThanOrEqual(5);
  });

  it('takes only the marked block, and only unqualified deletes', () => {
    const sql = [
      'DELETE FROM before_the_marker;',
      '-- @full-clear',
      'DROP TABLE IF EXISTS scratch;',
      'DELETE FROM contracts;',
      "DELETE FROM lots WHERE id = 'x';", // scoped: not a full clear
      'DELETE FROM authorities;',
      '',
      'DELETE FROM after_the_block;',
    ].join('\n');
    expect(fullClearTables(sql)).toEqual(['contracts', 'authorities']);
  });

  it('sees a table however it is quoted', () => {
    // `DELETE FROM "search_index";` is valid SQLite and reads as pure formatting. A bare-identifier
    // matcher dropped it from the list, which silently reopened the data-loss hole: the guard would
    // then wave through a corpus whose only populated table was the re-quoted one.
    const sql = [
      '-- @full-clear',
      'DELETE FROM "search_index";',
      'DELETE FROM `flow_pairs`;',
      'DELETE FROM [home_totals];',
      'delete from contracts;',
      '',
    ].join('\n');
    expect(fullClearTables(sql)).toEqual([
      'search_index',
      'flow_pairs',
      'home_totals',
      'contracts',
    ]);
  });

  it('returns nothing when the marker is absent', () => {
    expect(fullClearTables('DELETE FROM contracts;\nDELETE FROM lots;\n')).toEqual([]);
  });
});
