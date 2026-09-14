// Shared Node pipeline for the Container and the existing Actions job. Local mode never calls Wrangler.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileDigest } from './cacbg/build-proof.mjs';
import { assertD1TargetAuthorized, parseWranglerJson, TABLES } from './ship-related-persons.mjs';
const flag = (n) => process.argv.includes(`--${n}`);
const value = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? null : process.argv[i + 1];
};
const remote = flag('remote');
const work = resolve(value('work-dir') ?? 'data/work/declarations-job');
const db = join(work, 'backfill.sqlite');
const raw = resolve(process.env.CACBG_RAW ?? 'scratch/cacbg/raw');
const staging = resolve(process.env.CACBG_STAGING ?? 'scratch/cacbg/staging');
const env = {
  ...process.env,
  CACBG_DB: db,
  CACBG_REGISTRY_DB: db,
  CACBG_RAW: raw,
  CACBG_STAGING: staging,
  TR_CACHE_DB: join(work, 'verdicts.sqlite'),
};
const run = (script, args = []) =>
  execFileSync(process.execPath, ['--import', './scripts/cacbg/register-ts.mjs', script, ...args], {
    env,
    stdio: 'inherit',
  });
const wrangler = (args, output = false) =>
  execFileSync('wrangler', args, {
    cwd: resolve('apps/web'),
    env,
    encoding: 'utf8',
    stdio: output ? 'pipe' : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
  });
const d1 = process.env.SIGMA_D1_NAME;
mkdirSync(work, { recursive: true });
if (remote) {
  if (!flag('yes')) throw Error('--remote requires --yes');
  const info = JSON.parse(wrangler(['d1', 'info', d1, '--json'], true));
  assertD1TargetAuthorized({
    remote,
    shipEnv: env.SIGMA_SHIP_ENV ?? '',
    d1Name: d1,
    expectedId: env.SIGMA_D1_ID,
    resolvedId: info.uuid ?? info.database_id,
  });
  run('scripts/wrangler-render.mjs', ['apps/web/wrangler.jsonc']);
  copyFileSync('apps/web/wrangler.deploy.jsonc', 'apps/web/wrangler.jsonc');
  for (const name of [
    '0003_related_persons_foundation',
    '0009_interest_link_evidence',
    '0010_publishing_gate_constraints',
    '0012_person_redirects',
    '0014_person_profile',
    '0015_person_observations',
    '0018_person_entities',
  ])
    wrangler([
      'd1',
      'execute',
      d1,
      '--remote',
      '--yes',
      '--file',
      resolve(`packages/db/migrations/${name}.sql`),
    ]);
  // Observation tables are idempotent; add the role boundary once, independently of job retries.
  const registrySchema = join(work, 'registry-identity-schema.sql');
  writeFileSync(
    registrySchema,
    readFileSync('packages/db/migrations/0017_registry_identity_observations.sql', 'utf8').replace(
      'ALTER TABLE registry_roles ADD COLUMN uncertain_after TEXT;',
      '',
    ),
  );
  wrangler(['d1', 'execute', d1, '--remote', '--yes', '--file', registrySchema]);
  const columns = parseWranglerJson(
    wrangler(
      ['d1', 'execute', d1, '--remote', '--json', '--command', 'PRAGMA table_info(registry_roles)'],
      true,
    ),
  );
  if (!columns.flatMap((r) => r.results ?? []).some((c) => c.name === 'uncertain_after'))
    wrangler([
      'd1',
      'execute',
      d1,
      '--remote',
      '--yes',
      '--command',
      'ALTER TABLE registry_roles ADD COLUMN uncertain_after TEXT',
    ]);
  wrangler([
    'd1',
    'execute',
    d1,
    '--remote',
    '--yes',
    '--file',
    resolve('packages/db/migrations/0019_registry_scoped_birthdates.sql'),
  ]);
  wrangler([
    'd1',
    'execute',
    d1,
    '--remote',
    '--yes',
    '--file',
    resolve('packages/db/migrations/0020_registry_company_history.sql'),
  ]);
  const tables = [
    ...new Set([
      'bidders',
      'contracts',
      'tenders',
      'authorities',
      'registry_deeds',
      'registry_roles',
      'registry_persons',
      'registry_identity_observations',
      'registry_identity_snapshots',
      'registry_company_history',
      ...TABLES,
    ]),
  ];
  const sql = join(work, 'source.sql');
  rmSync(sql, { force: true });
  wrangler([
    'd1',
    'export',
    d1,
    '--remote',
    '--yes',
    ...tables.flatMap((t) => ['--table', t]),
    '--output',
    sql,
  ]);
  rmSync(db, { force: true });
  execFileSync('sqlite3', [db], { input: readFileSync(sql) });
  const local = new DatabaseSync(db, { readOnly: true });
  for (const t of tables) {
    const answer = parseWranglerJson(
      wrangler(
        ['d1', 'execute', d1, '--remote', '--json', '--command', `SELECT COUNT(*) n FROM ${t}`],
        true,
      ),
    );
    if (local.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n !== answer[0]?.results[0]?.n)
      throw Error(`Incomplete source export: ${t}`);
  }
  local.close();
  rmSync(sql, { force: true });
} else {
  const source = value('source-db');
  if (!source) throw Error('Local job requires --source-db');
  if (resolve(source) === db) throw Error('Source and work DB must differ');
  rmSync(db, { force: true });
  const localSource = new DatabaseSync(source, { readOnly: true });
  localSource.prepare('VACUUM INTO ?').run(db);
  localSource.close();
}
const r2 = flag('r2');
const bucket = env.DECLARATIONS_BUCKET;
let restored = null;
const object = (operation, key, file) =>
  wrangler(['r2', 'object', operation, `${bucket}/${key}`, '--file', file, '--remote']);
if (r2) {
  if (!remote || !bucket) throw Error('R2 requires an explicitly authorized remote target');
  restored = JSON.parse(env.DECLARATIONS_RESTORE ?? 'null');
  if (restored !== null) {
    if (!Array.isArray(restored.folders)) throw Error('Invalid corpus checkpoint');
    mkdirSync(raw, { recursive: true });
    for (const entry of restored.folders) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(entry.folder) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.key !== `declarations/raw/${entry.sha256}.tgz`
      )
        throw Error('Invalid corpus archive');
      const archive = join(work, 'restore.tgz');
      object('get', entry.key, archive);
      if ((await fileDigest(archive)) !== entry.sha256) throw Error('Corpus checksum mismatch');
      const listing = execFileSync('tar', ['-tzf', archive], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      if (
        listing
          .split('\n')
          .filter(Boolean)
          .some((p) => !p.startsWith(entry.folder + '/') || p.split('/').includes('..'))
      )
        throw Error('Unsafe corpus archive path');
      execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', raw]);
      rmSync(archive, { force: true });
    }
  }
}
// ponytail: each folder archive must fit Wrangler's object upload limit; split with standard tools if a folder grows beyond it.
async function checkpoint() {
  const folders = [];
  for (const entry of readdirSync(raw, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.name)) throw Error('Invalid corpus folder');
    const archive = join(work, 'corpus.tgz');
    execFileSync('tar', ['-czf', archive, '-C', raw, entry.name]);
    const sha256 = await fileDigest(archive);
    const key = `declarations/raw/${sha256}.tgz`;
    if (!restored?.folders.some((f) => f.sha256 === sha256)) object('put', key, archive);
    folders.push({ folder: entry.name, sha256, key });
    rmSync(archive, { force: true });
  }
  const manifest = join(work, 'working.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      runId: env.SIGMA_RUN_ID ?? null,
      complete: existsSync(join(raw, '.corpus-complete.json')),
      folders,
    }),
  );
  object('put', 'declarations/working.json', manifest); // only after every archive was acknowledged
}
if (!flag('skip-fetch')) {
  try {
    run('scripts/cacbg/fetch.mjs', ['--deadline-minutes', '180']);
  } finally {
    if (r2 && existsSync(raw)) await checkpoint();
  }
}
run('scripts/cacbg/extract.mjs'); // registry was hydrated before identity extraction
if (env.CACBG_COMPANY_CATALOG)
  run('scripts/cacbg/request-companies.mjs', [
    '--catalog',
    env.CACBG_COMPANY_CATALOG,
    '--db',
    db,
    '--staging',
    staging,
  ]);
if (r2) rmSync(raw, { recursive: true, force: true }); // bounded peak disk before bootstrap DB copies
run('scripts/cacbg/load.mjs', ['--emit-candidates']);
run('scripts/tr/decide.mjs', [
  '--links-file',
  join(staging, 'candidate-links.jsonl'),
  '--registry-db',
  db,
]);
run('scripts/cacbg/load.mjs');
run('scripts/cacbg/audit.mjs');
if (remote) {
  run('scripts/ship-related-persons.mjs', ['--work-db', db, '--remote', '--yes']);
  const sql = execFileSync(
    process.execPath,
    [
      '--import',
      './scripts/cacbg/register-ts.mjs',
      'scripts/emit-refresh-group.mjs',
      'entity-search-index',
    ],
    { env, encoding: 'utf8' },
  );
  const file = join(work, 'reindex.sql');
  writeFileSync(file, sql);
  wrangler(['d1', 'execute', d1, '--remote', '--yes', '--file', file]);
  if (r2) object('put', 'declarations/accepted.json', join(work, 'working.json'));
} else run('scripts/ship-related-persons.mjs', ['--work-db', db, '--emit', join(work, 'ship')]);
console.log(
  JSON.stringify({ event: 'declarations_job_complete', runId: env.SIGMA_RUN_ID ?? null, remote }),
);
