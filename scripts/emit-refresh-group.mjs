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

process.stdout.write(`${found.statements.map((s) => `${s};`).join('\n')}\n`);
