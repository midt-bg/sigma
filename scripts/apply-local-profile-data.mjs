// Explicit local SQLite apply. No wrangler, credentials, HTTP client or remote execution path.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TABLES, WIPE_ORDER } from './ship-related-persons.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};
if (process.argv.some((a) => /remote|stage|production/i.test(a) && a.startsWith('--')))
  throw new Error('Local files only');
const local = (p) => {
  if (!p) throw new Error('Explicit local database paths required');
  const real = fs.realpathSync(path.resolve(p));
  if (!real.startsWith(root + path.sep))
    throw new Error('Database must be inside this local workspace');
  return real;
};
const source = local(arg('--work-db'));
const target = local(arg('--served-db'));
const staging = local(arg('--staging'));
if (
  !target.startsWith(path.join(root, 'apps/web/.wrangler/state') + path.sep) ||
  !target.endsWith('.sqlite')
)
  throw new Error('Target must be the local web emulator SQLite file');
if (source === target) throw new Error('Source and target must differ');
if (
  JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')).schemaVersion !== 6 ||
  !fs.existsSync(path.join(staging, 'published-snapshot.json'))
)
  throw new Error('A current extraction and the prior-publication snapshot are required');
// Applying local data has the same accuracy gate as building it. Never rely on
// a successful test run or an audit log from a different candidate database.
execFileSync(
  process.execPath,
  [
    '--import',
    path.join(root, 'scripts/cacbg/register-ts.mjs'),
    path.join(root, 'scripts/cacbg/audit.mjs'),
  ],
  { cwd: root, env: { ...process.env, CACBG_DB: source, CACBG_STAGING: staging }, stdio: 'pipe' },
);
const src = new DatabaseSync(source, { readOnly: true });
const db = new DatabaseSync(target);
const count = (d, t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const before = {
  persons: count(db, 'persons'),
  declarations: count(db, 'declarations'),
  published: db.prepare("SELECT COUNT(*) n FROM interest_links WHERE status='published'").get().n,
};
if (count(src, 'persons') === 0 || count(src, 'declarations') === 0)
  throw new Error('Empty source');
for (const t of ['authorities', 'bidders', 'tenders', 'contracts']) {
  if (count(src, t) !== count(db, t))
    throw new Error(
      `Stale local build: ${t} differs from the served corpus; rebuild before applying`,
    );
}
const bad = src
  .prepare(
    "SELECT count(*) n FROM declarations WHERE institution IN ('Встъпителни и финални декларации','Ежегодни декларации')",
  )
  .get().n;
if (bad) throw new Error(`${bad} declaration categories still masquerade as institutions`);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;');
try {
  db.exec('BEGIN IMMEDIATE');
  db.exec(
    fs.readFileSync(path.join(root, 'packages/db/migrations/0014_person_profile.sql'), 'utf8'),
  );
  db.exec(
    fs.readFileSync(path.join(root, 'packages/db/migrations/0015_person_observations.sql'), 'utf8'),
  );
  for (const t of WIPE_ORDER)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
      db.exec(`DELETE FROM ${t}`);
  for (const t of TABLES) {
    const columns = src
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
    if (!columns.length) throw new Error(`Missing source table ${t}`);
    const insert = db.prepare(
      `INSERT INTO ${t} (${columns.map((c) => '"' + c + '"').join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    );
    for (const row of src.prepare(`SELECT * FROM ${t}`).iterate())
      insert.run(...columns.map((c) => row[c]));
    if (count(src, t) !== count(db, t)) throw new Error(`Count mismatch: ${t}`);
  }
  // Only the declared-interest projection is affected; preserve consortium and subcontract edges.
  const precompute = fs.readFileSync(path.join(root, 'scripts/precompute.sql'), 'utf8');
  const from = precompute.indexOf('WITH surfaced AS (');
  const until = precompute.indexOf(';', from);
  if (from < 0 || until < 0) throw new Error('Declared graph refresh unavailable');
  db.exec(
    "DELETE FROM company_links WHERE kind='declared_stake';" + precompute.slice(from, until + 1),
  );
  const search = arg('--refresh-sql');
  if (!search) throw new Error('--refresh-sql required');
  db.exec(fs.readFileSync(local(search), 'utf8'));
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key violation');
  db.exec('COMMIT');
  console.log(
    JSON.stringify(
      {
        target,
        before,
        after: {
          persons: count(db, 'persons'),
          declarations: count(db, 'declarations'),
          published: db
            .prepare("SELECT COUNT(*) n FROM interest_links WHERE status='published'")
            .get().n,
        },
        appliedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch (e) {
  if (db.isTransaction) db.exec('ROLLBACK');
  throw e;
} finally {
  db.close();
  src.close();
}
