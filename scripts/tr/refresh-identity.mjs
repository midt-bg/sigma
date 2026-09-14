// Explicit local backfill through the same parser and writer as the daily ETL.
// Full XML is held in memory only. Output contains the existing role projection and identity observations.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { registryClient } from '../../packages/ingest/src/registry.ts';
import { storeDeed } from '../../apps/etl/src/registry.ts';
import { d1FromSqlite } from '../../packages/test-support/src/d1-sqlite.ts';
import { assertOverrideDirSafe } from '../cacbg/guard.mjs';
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
if (!process.argv.includes('--db') || !process.argv.includes('--eiks'))
  throw new Error('--db and --eiks required');
const file = path.resolve(arg('--db'));
assertOverrideDirSafe(path.dirname(file), '--db');
const db = new DatabaseSync(file);
db.exec(
  fs.readFileSync(
    new URL('../../packages/db/migrations/0016_registry_entry_sync.sql', import.meta.url),
    'utf8',
  ),
);
if (
  !db
    .prepare('PRAGMA table_info(registry_roles)')
    .all()
    .some((c) => c.name === 'uncertain_after')
)
  db.exec(
    fs.readFileSync(
      new URL(
        '../../packages/db/migrations/0017_registry_identity_observations.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
db.exec(
  fs.readFileSync(
    new URL('../../packages/db/migrations/0019_registry_scoped_birthdates.sql', import.meta.url),
    'utf8',
  ),
);
const d1 = d1FromSqlite(db);
const client = registryClient({ baseUrl: 'https://api-sigma-cr.registryagency.bg' });
const eiks = [...new Set(fs.readFileSync(arg('--eiks'), 'utf8').split(/\s+/).filter(Boolean))];
let read = 0,
  skipped = 0,
  failed = 0;
try {
  for (const eik of eiks) {
    if (!/^\d{9}$/.test(eik)) throw new Error('Invalid partida EIK');
    if (
      !process.argv.includes('--refresh') &&
      db.prepare('SELECT 1 FROM registry_identity_snapshots WHERE eik=?').get(eik)
    ) {
      skipped++;
      continue;
    }
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        const result = await client.deed(eik);
        await storeDeed(d1, eik, result, new Date().toISOString());
        done = true;
        read++;
      } catch (e) {
        if (attempt === 3) {
          failed++;
          console.error(JSON.stringify({ eik, error: String(e) }));
        } else await pause(e.retryMs ?? 30_000);
      }
    }
    if (read % 20 === 0) console.log(JSON.stringify({ read, skipped, failed, total: eiks.length }));
    await pause(1050);
  }
  console.log(JSON.stringify({ read, skipped, failed, total: eiks.length }));
  if (failed) process.exitCode = 1;
} finally {
  db.close();
}
