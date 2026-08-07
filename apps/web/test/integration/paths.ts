import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const WRANGLER_JSONC = path.join(WEBROOT, 'apps/web/wrangler.jsonc');
export const MIG_0000 = path.join(WEBROOT, 'packages/db/migrations/0000_init.sql');
export const MIG_0001 = path.join(
  WEBROOT,
  'packages/db/migrations/0001_flow_pairs_bidder_index.sql',
);
// Migration 0002 adds `current_value_currency` — read by getContract (queries/details.ts) for
// amendment-currency conversions. The prod cloud D1 has it; without it the contract routes 500.
// Future migrations with new NOT NULL or DEFAULT-bearing columns this lane reads must be added
// here in lockstep.
export const MIG_0002 = path.join(
  WEBROOT,
  'packages/db/migrations/0002_current_value_currency.sql',
);
