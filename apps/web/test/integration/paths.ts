import path from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WEBROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const WRANGLER_JSONC = path.join(WEBROOT, 'apps/web/wrangler.jsonc');

const MIGRATIONS_DIR = path.join(WEBROOT, 'packages/db/migrations');

/**
 * Discover every shipped migration in numeric order. `bootstrapProxy()` applies them all
 * sequentially so a future migration that adds an object (table/index/trigger/column) referenced
 * by a later one keeps working without manual update. Hand-picked subsets
 * (`[0000, 0001, 0002, 0006, 0007]`) used to silently break if a skipped migration created an
 * object that 0006/0007 ALTER-ed (PR #177 review T-009). The discovery is keyed by the leading
 * 4-digit ordinal so it survives cosmetic renames.
 *
 * The export is a tuple of `[migrationSqlPath, ordinal]` pairs sorted ascending. Tests can
 * inspect `LISTED_MIGRATIONS` to assert the lane stays in lockstep with the `packages/db`
 * source of truth.
 */
export const LISTED_MIGRATIONS: ReadonlyArray<{ path: string; ordinal: number }> = readdirSync(
  MIGRATIONS_DIR,
)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .map((name) => ({
    path: path.join(MIGRATIONS_DIR, name),
    ordinal: Number.parseInt(name.slice(0, 4), 10),
  }))
  .sort((a, b) => a.ordinal - b.ordinal);
