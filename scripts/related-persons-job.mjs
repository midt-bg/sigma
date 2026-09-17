// Shared Node pipeline for the Container and the existing Actions job. Local mode never calls Wrangler.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { corpusStore, CORPUS_STAMP, CORPUS_VERSION, digest } from './cacbg/corpus.mjs';
import { importSql } from './cacbg/import-sql.mjs';
import { progress } from './cacbg/progress.mjs';
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
// The container is stopped with a signal to its whole process group. `execFileSync` blocks the event
// loop, so without a handler Node's default disposition would kill this process before the stage that
// is doing the work can accept what it has and exit 75. The handler is deliberately empty: the stage
// below gets the same signal and its exit code carries the decision up.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {});

let stage = 'fetch';
const setStage = (next) => {
  stage = next;
  progress(stage, 0, undefined, true);
};
const run = (script, args = []) => {
  try {
    return execFileSync(
      process.execPath,
      ['--import', './scripts/cacbg/register-ts.mjs', script, ...args],
      { env, stdio: 'inherit' },
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'declarations_error',
        stage,
        script,
        exitCode: error.status ?? null,
        signal: error.signal ?? null,
      }),
    );
    process.exit(error.status === 75 ? 75 : 1);
  }
};
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
}
const r2 = flag('r2');
// A slot rebuild (ADR-0048) reads the corpus from R2 but publishes nothing itself.
const rebuild = env.SIGMA_REBUILD === '1';
if (
  r2 &&
  ((!remote && !rebuild) || env.CACBG_CORPUS_URL !== 'http://declarations.r2' || !env.SIGMA_RUN_ID)
)
  throw Error('R2 requires a logical run ID and the private Container corpus binding');
const corpus = corpusStore(raw);
let sourceStamp;
if (r2) {
  const accepted = await corpus.get('accepted.json');
  const receipt = accepted ? JSON.parse(accepted) : null;
  if (receipt?.runId === env.SIGMA_RUN_ID && receipt.audit === true && receipt.published === true) {
    console.log(JSON.stringify({ event: 'declarations_job_complete', ...receipt }));
    process.exit(0); // Publication completed before the previous container's status was recorded.
  }
  const stamp = await corpus.get(CORPUS_STAMP);
  const parsed = stamp ? JSON.parse(stamp) : null;
  if (
    parsed?.runId === env.SIGMA_RUN_ID &&
    parsed.schemaVersion === CORPUS_VERSION &&
    parsed.incomplete === false
  )
    sourceStamp = stamp;
}
if (!sourceStamp && !flag('skip-fetch')) {
  setStage('fetch');
  run(
    'scripts/cacbg/fetch.mjs',
    // A rebuild cannot yield: its container holds the whole build, so the fetch runs to the end.
    r2 && !rebuild
      ? ['--deadline-minutes', '60', '--yield-on-deadline']
      : ['--deadline-minutes', rebuild ? '600' : '180'],
  );
}
if (r2) {
  sourceStamp ??= await corpus.get(CORPUS_STAMP);
  if (!sourceStamp || JSON.parse(sourceStamp).runId !== env.SIGMA_RUN_ID)
    throw Error('No complete corpus for this logical run');
}
setStage('snapshot');
if (remote) {
  for (const name of [
    '0003_related_persons_foundation',
    '0009_interest_link_evidence',
    '0010_publishing_gate_constraints',
    '0012_person_redirects',
    '0014_person_profile',
    '0015_person_observations',
    '0018_person_entities',
    '0022_person_relatives',
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
  for (const name of ['0019_registry_scoped_birthdates', '0020_registry_company_history'])
    wrangler([
      'd1',
      'execute',
      d1,
      '--remote',
      '--yes',
      '--file',
      resolve(`packages/db/migrations/${name}.sql`),
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
    '--skip-confirmation',
    ...tables.flatMap((t) => ['--table', t]),
    '--output',
    sql,
  ]);
  rmSync(db, { force: true });
  console.log('Importing the D1 snapshot into the working SQLite database …');
  importSql(db, sql);
  console.log('Working SQLite database imported; checking table counts …');
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
setStage('extract');
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
setStage('candidates');
run('scripts/cacbg/load.mjs', ['--emit-candidates']);
setStage('decide');
run('scripts/tr/decide.mjs', [
  '--links-file',
  join(staging, 'candidate-links.jsonl'),
  '--registry-db',
  db,
]);
setStage('load');
run('scripts/cacbg/load.mjs');
setStage('audit');
run('scripts/cacbg/audit.mjs');
if (remote) {
  setStage('publish');
  run('scripts/ship-related-persons.mjs', ['--work-db', db, '--remote', '--yes']);
  setStage('reindex');
  const emitRefreshGroup = (group, extraEnv = {}) =>
    execFileSync(
      process.execPath,
      ['--import', './scripts/cacbg/register-ts.mjs', 'scripts/emit-refresh-group.mjs', group],
      { env: { ...env, SIGMA_OFFICIAL_PERSON_IDS_JSON: '', ...extraEnv }, encoding: 'utf8' },
    );
  const applyReindex = (name, sql) => {
    const file = join(work, `${name}.sql`);
    writeFileSync(file, sql);
    wrangler(['d1', 'execute', d1, '--remote', '--yes', '--file', file]);
  };

  applyReindex('reindex-entities', emitRefreshGroup('entity-search-index'));

  // The full official search query exceeded D1's per-query CPU limit once the contract corpus reached
  // ~200k rows. Rebuild it in small person chunks; each emitted file is one atomic delete+insert for its
  // chunk, and old rows remain available until their replacement succeeds.
  const reindexDb = new DatabaseSync(db, { readOnly: true });
  const officialIds = reindexDb
    .prepare(
      `SELECT DISTINCT person_id FROM interest_links
       WHERE status='published' AND interest_class IN ('private_ownership','family_ownership')
       ORDER BY person_id`,
    )
    .all()
    .map((row) => row.person_id);
  reindexDb.close();
  const chunkSize = 25;
  for (let offset = 0; offset < officialIds.length; offset += chunkSize) {
    const ids = officialIds.slice(offset, offset + chunkSize);
    applyReindex(
      `reindex-officials-${String(offset / chunkSize + 1).padStart(3, '0')}`,
      emitRefreshGroup('official-search-index', {
        SIGMA_OFFICIAL_PERSON_IDS_JSON: JSON.stringify(ids),
      }),
    );
  }
  wrangler([
    'd1',
    'execute',
    d1,
    '--remote',
    '--yes',
    '--command',
    `DELETE FROM search_index WHERE kind='official' AND ref NOT IN (
       SELECT DISTINCT person_id FROM interest_links
       WHERE status='published' AND interest_class IN ('private_ownership','family_ownership')
     )`,
  ]);
  // Everyone else with a page, after the officials are final.
  wrangler([
    'd1',
    'execute',
    d1,
    '--remote',
    '--yes',
    '--file',
    resolve('scripts/person-search-index.sql'),
  ]);
  if (r2) {
    const stamp = await corpus.get(CORPUS_STAMP);
    if (!stamp || digest(stamp) !== digest(sourceStamp))
      throw Error('Published corpus stamp changed');
    await corpus.put(
      'accepted.json',
      Buffer.from(
        JSON.stringify({
          runId: env.SIGMA_RUN_ID,
          completedAt: new Date().toISOString(),
          corpusHash: digest(sourceStamp),
          corpus: JSON.parse(sourceStamp),
          audit: true,
          published: true,
        }),
      ),
    );
  }
} else run('scripts/ship-related-persons.mjs', ['--work-db', db, '--emit', join(work, 'ship')]);
console.log(
  JSON.stringify({
    event: 'declarations_job_complete',
    runId: env.SIGMA_RUN_ID ?? null,
    audit: true,
    published: remote,
  }),
);
