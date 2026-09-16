// Emit ONE named refresh-slice batch group as executable SQL, using the SAME parser the sigma-etl Worker
// runs (packages/ingest `refreshSliceStatementGroups`). Single source of truth: a workflow reindex step
// that pipes this into `wrangler d1 execute` can never drift from what the cron executes. Prints to stdout.
//
// Run under the register-ts loader (the parser is TS, no runtime deps):
//   node --import ./scripts/cacbg/register-ts.mjs scripts/emit-refresh-group.mjs entity-search-index
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const group = process.argv[2];
if (!group) {
  console.error('usage: emit-refresh-group.mjs <group-name>');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { refreshSliceStatementGroups } = await import('../packages/ingest/src/refresh.ts');
const sql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
const found = refreshSliceStatementGroups(sql).find((g) => g.name === group);
if (!found) {
  console.error(`refresh-slice.sql has no @refresh-batch group '${group}'`);
  process.exit(1);
}

const statements = [...found.statements];
const scopedIdsJson = process.env.SIGMA_OFFICIAL_PERSON_IDS_JSON;
if (scopedIdsJson) {
  if (group !== 'official-search-index')
    throw new Error('SIGMA_OFFICIAL_PERSON_IDS_JSON is valid only for official-search-index');
  const ids = JSON.parse(scopedIdsJson);
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id))
    throw new Error('SIGMA_OFFICIAL_PERSON_IDS_JSON must be a non-empty string array');
  const scopeInsert = statements.findIndex((statement) =>
    statement.includes('INSERT INTO refresh_official_reindex_scope'),
  );
  if (scopeInsert < 0) throw new Error('official-search-index has no scope insert');
  statements[scopeInsert] =
    'INSERT INTO refresh_official_reindex_scope (person_id) VALUES ' +
    ids.map((id) => `('${id.replaceAll("'", "''")}')`).join(',');
}

process.stdout.write(`${statements.map((s) => `${s};`).join('\n')}\n`);
