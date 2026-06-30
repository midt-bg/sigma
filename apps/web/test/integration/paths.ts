import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const WRANGLER_JSONC = path.join(WEBROOT, 'apps/web/wrangler.jsonc');
export const MIG_0000 = path.join(WEBROOT, 'packages/db/migrations/0000_init.sql');
export const MIG_0001 = path.join(WEBROOT, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
