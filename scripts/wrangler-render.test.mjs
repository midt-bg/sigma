import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('renders distinct refresh and registry Workflow names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-'));
  const config = join(dir, 'wrangler.toml');
  writeFileSync(
    config,
    `name = "sigma-etl"

[[workflows]]
binding = "REFRESH"
name = "sigma-refresh"
class_name = "RefreshWorkflow"

[[workflows]]
binding = "REGISTRY"
name = "sigma-registry"
class_name = "RegistryWorkflow"
`,
  );

  process.argv[2] = config;
  process.env.SIGMA_ETL_NAME = 'sigma-etl-stage';
  process.env.SIGMA_WORKFLOW_NAME = 'sigma-refresh-stage';
  process.env.SIGMA_REGISTRY_WORKFLOW_NAME = 'sigma-registry-stage';
  await import(`./wrangler-render.mjs?test=${Date.now()}`);

  const rendered = readFileSync(join(dir, 'wrangler.deploy.toml'), 'utf8');
  assert.match(rendered, /^name = "sigma-etl-stage"/m);
  assert.match(rendered, /binding = "REFRESH"\nname = "sigma-refresh-stage"/);
  assert.match(rendered, /binding = "REGISTRY"\nname = "sigma-registry-stage"/);
});

test('renders the declarations Workflow, bucket and the container target vars per environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-'));
  const config = join(dir, 'wrangler.toml');
  writeFileSync(
    config,
    `name = "sigma-etl"

[vars]
DECLARATIONS_BUCKET = "sigma-declarations"
SIGMA_D1_ID = "00000000-0000-0000-0000-000000000000"
SIGMA_D1_NAME = "sigma"
SIGMA_SHIP_ENV = "production"

[[d1_databases]]
binding = "DB"
database_name = "sigma"
database_id = "00000000-0000-0000-0000-000000000000"

[[workflows]]
binding = "DECLARATIONS_RUN"
name = "sigma-declarations"
class_name = "DeclarationsWorkflow"

[[workflows]]
binding = "REBUILD_RUN"
name = "sigma-rebuild"
class_name = "RebuildWorkflow"

[[r2_buckets]]
binding = "DECLARATIONS_CORPUS"
bucket_name = "sigma-declarations"
`,
  );
  process.argv[2] = config;
  process.env.SIGMA_ETL_NAME = 'sigma-etl-stage';
  process.env.SIGMA_D1_ID = '11111111-2222-4333-8444-555555555555';
  process.env.SIGMA_D1_NAME = 'sigma-stage-green';
  process.env.SIGMA_SHIP_ENV = 'staging';
  process.env.SIGMA_DECLARATIONS_WORKFLOW_NAME = 'sigma-declarations-stage';
  process.env.SIGMA_DECLARATIONS_BUCKET = 'sigma-declarations-stage';
  process.env.SIGMA_REBUILD_WORKFLOW_NAME = 'sigma-rebuild-stage';
  await import(`./wrangler-render.mjs?test=${Date.now()}`);
  const rendered = readFileSync(join(dir, 'wrangler.deploy.toml'), 'utf8');
  assert.match(rendered, /^DECLARATIONS_BUCKET = "sigma-declarations-stage"$/m);
  assert.match(rendered, /^SIGMA_D1_ID = "11111111-2222-4333-8444-555555555555"$/m);
  assert.match(rendered, /^SIGMA_D1_NAME = "sigma-stage-green"$/m);
  assert.match(rendered, /^SIGMA_SHIP_ENV = "staging"$/m);
  assert.match(rendered, /^database_name = "sigma-stage-green"$/m);
  assert.match(rendered, /binding = "DECLARATIONS_RUN"\nname = "sigma-declarations-stage"/);
  assert.match(rendered, /^bucket_name = "sigma-declarations-stage"$/m);
  assert.match(rendered, /binding = "REBUILD_RUN"\nname = "sigma-rebuild-stage"/);
});

// Both rails fail OPEN when they break: the deploy still produces a config, only one carrying the
// committed PRODUCTION names, so the mistake stays invisible until it targets the wrong resource.
test('renames for a config that sets only the newer names, and only the named bucket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-'));
  const config = join(dir, 'wrangler.toml');
  writeFileSync(
    config,
    `name = "sigma-etl"

[[r2_buckets]]
binding = "DECLARATIONS_CORPUS"
bucket_name = "sigma-declarations"

[[r2_buckets]]
binding = "REPORTS"
bucket_name = "sigma-reports"
`,
  );

  process.argv[2] = config;
  for (const k of [
    'SIGMA_ETL_NAME',
    'SIGMA_WORKFLOW_NAME',
    'SIGMA_REGISTRY_WORKFLOW_NAME',
    'SIGMA_DECLARATIONS_WORKFLOW_NAME',
    'SIGMA_REBUILD_WORKFLOW_NAME',
    'SIGMA_D1_NAME',
    'SIGMA_SHIP_ENV',
  ])
    delete process.env[k];
  process.env.SIGMA_DECLARATIONS_BUCKET = 'sigma-declarations-stage';
  await import(`./wrangler-render.mjs?test=${Date.now()}`);

  const rendered = readFileSync(join(dir, 'wrangler.deploy.toml'), 'utf8');
  assert.match(
    rendered,
    /binding = "DECLARATIONS_CORPUS"\nbucket_name = "sigma-declarations-stage"/,
  );
  assert.match(rendered, /binding = "REPORTS"\nbucket_name = "sigma-reports"/);
});

const ETL = `name = "sigma-etl"

[triggers]
crons = ["0 */6 * * *", "0 3 * * 1"]
`;
async function renderEtl(schedule) {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-'));
  const config = join(dir, 'wrangler.toml');
  writeFileSync(config, ETL);
  process.argv[2] = config;
  for (const k of [
    'SIGMA_ETL_NAME',
    'SIGMA_WORKFLOW_NAME',
    'SIGMA_REGISTRY_WORKFLOW_NAME',
    'SIGMA_DECLARATIONS_WORKFLOW_NAME',
    'SIGMA_REBUILD_WORKFLOW_NAME',
    'SIGMA_DECLARATIONS_BUCKET',
    'SIGMA_D1_NAME',
    'SIGMA_SHIP_ENV',
  ])
    delete process.env[k];
  if (schedule === undefined) delete process.env.SIGMA_ETL_SCHEDULE;
  else process.env.SIGMA_ETL_SCHEDULE = schedule;
  try {
    await import(`./wrangler-render.mjs?test=${Date.now()}-${Math.random()}`);
  } finally {
    delete process.env.SIGMA_ETL_SCHEDULE;
  }
  return readFileSync(join(dir, 'wrangler.deploy.toml'), 'utf8');
}

test('a parked ETL deploys without Cron Triggers and keeps its name', async () => {
  const rendered = await renderEtl('off');
  assert.match(rendered, /\[triggers\]\ncrons = \[\]/);
  assert.match(rendered, /^name = "sigma-etl"/m);
});

test('the ETL keeps its crons unless parked', async () => {
  for (const schedule of [undefined, '', 'on'])
    assert.match(await renderEtl(schedule), /crons = \["0 \*\/6 \* \* \*", "0 3 \* \* 1"\]/);
});

test('a schedule that is neither on nor off is refused', async () => {
  await assert.rejects(() => renderEtl('of'), /SIGMA_ETL_SCHEDULE must be on or off, got "of"/);
});

/** A `[[section]]` or `[section]` block of a TOML file, up to the next header. */
const block = (text, header) => {
  const start = text.indexOf(`${header}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + header.length + 1);
  const end = rest.search(/^\[/m);
  return rest.slice(0, end < 0 ? undefined : end).trim();
};

test('the rebuild runner is the ETL’s code and container, with one Workflow, no schedule and no database', () => {
  const runner = readFileSync('apps/etl/wrangler.rebuild-runner.toml', 'utf8');
  const etl = readFileSync('apps/etl/wrangler.toml', 'utf8');
  for (const key of ['main', 'compatibility_date', 'compatibility_flags'])
    assert.equal(
      runner.match(new RegExp(`^${key} = (.*)$`, 'm'))[1],
      etl.match(new RegExp(`^${key} = (.*)$`, 'm'))[1],
      key,
    );
  for (const header of ['[[containers]]', '[[durable_objects.bindings]]', '[[migrations]]'])
    assert.equal(block(runner, header), block(etl, header), header);
  assert.equal(runner.match(/^\[\[workflows\]\]$/gm).length, 1);
  assert.equal(
    block(runner, '[[workflows]]'),
    'binding = "REBUILD_RUN"\nname = "sigma-rebuild-cutover"\nclass_name = "RebuildWorkflow"',
  );
  assert.equal(block(runner, '[triggers]'), null, 'no Cron Triggers');
  assert.equal(block(runner, '[[d1_databases]]'), null, 'no database binding');
});

test('the rebuild runner renders with the environment’s names and the shipped commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-'));
  const config = join(dir, 'wrangler.rebuild-runner.toml');
  writeFileSync(config, readFileSync('apps/etl/wrangler.rebuild-runner.toml', 'utf8'));
  process.argv[2] = config;
  const env = {
    SIGMA_ETL_NAME: 'sigma-rebuild-runner-dev2',
    SIGMA_REBUILD_WORKFLOW_NAME: 'sigma-rebuild-cutover-dev2',
    SIGMA_DECLARATIONS_BUCKET: 'sigma-declarations-dev2',
    SIGMA_D1_NAME: 'sigma-dev2-green',
    SIGMA_SHIP_ENV: 'dev2',
    SIGMA_SOURCE_COMMIT: 'abc1234',
  };
  Object.assign(process.env, env);
  try {
    await import(`./wrangler-render.mjs?test=${Date.now()}-runner`);
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
  const rendered = readFileSync(join(dir, 'wrangler.deploy.rebuild-runner.toml'), 'utf8');
  assert.match(rendered, /^name = "sigma-rebuild-runner-dev2"/m);
  assert.match(rendered, /binding = "REBUILD_RUN"\nname = "sigma-rebuild-cutover-dev2"/);
  assert.match(rendered, /bucket_name = "sigma-declarations-dev2"/);
  assert.match(rendered, /SIGMA_D1_NAME = "sigma-dev2-green"/);
  assert.match(rendered, /SIGMA_SOURCE_COMMIT = "abc1234"/);
  assert.doesNotMatch(
    rendered,
    /"sigma-declarations"|"sigma-rebuild-cutover"|^name = "sigma-rebuild-runner"$/m,
  );
});

function renderWeb(env, configText) {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-wrangler-render-web-'));
  const config = join(dir, 'wrangler.jsonc');
  writeFileSync(config, configText ?? readFileSync('apps/web/wrangler.jsonc', 'utf8'));
  const run = spawnSync(process.execPath, ['scripts/wrangler-render.mjs', config], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SIGMA_D1_ID: '11111111-2222-4333-8444-555555555555', ...env },
  });
  const out = join(dir, 'wrangler.deploy.jsonc');
  return { run, read: () => readFileSync(out, 'utf8') };
}

function limiterIds(text) {
  const obj = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  return Object.fromEntries(
    obj.unsafe.bindings.filter((b) => b.type === 'ratelimit').map((b) => [b.name, b.namespace_id]),
  );
}

test('production keeps the committed rate-limit ids; Stage and dev each get their own', () => {
  const committed = limiterIds(readFileSync('apps/web/wrangler.jsonc', 'utf8'));
  const production = renderWeb({ SIGMA_SHIP_ENV: 'production' });
  assert.equal(production.run.status, 0, production.run.stderr);
  assert.deepEqual(limiterIds(production.read()), committed);

  const seen = new Set(Object.values(committed));
  for (const env of ['staging', 'dev']) {
    const rendered = renderWeb({ SIGMA_SHIP_ENV: env, SIGMA_WEB_NAME: `sigma-${env}` });
    assert.equal(rendered.run.status, 0, rendered.run.stderr);
    const ids = limiterIds(rendered.read());
    assert.deepEqual(Object.keys(ids).sort(), Object.keys(committed).sort());
    for (const id of Object.values(ids)) {
      assert.ok(!seen.has(id), `${env} reuses namespace_id ${id}`);
      seen.add(id);
    }
  }
});

test('refuses an unknown environment and a limiter without an id for it', () => {
  const unknown = renderWeb({ SIGMA_SHIP_ENV: 'prod' });
  assert.notEqual(unknown.run.status, 0);
  assert.match(unknown.run.stderr, /SIGMA_SHIP_ENV must be production/);

  const extra = renderWeb(
    { SIGMA_SHIP_ENV: 'staging' },
    readFileSync('apps/web/wrangler.jsonc', 'utf8').replace(
      '"bindings": [',
      '"bindings": [{ "name": "NEW_RATE_LIMITER", "type": "ratelimit", "namespace_id": "1099" },',
    ),
  );
  assert.notEqual(extra.run.status, 0);
  assert.match(extra.run.stderr, /no staging namespace_id for rate-limit binding NEW_RATE_LIMITER/);
});

test('refuses a web config without the fail-closed conflicts limiter', () => {
  const config = readFileSync('apps/web/wrangler.jsonc', 'utf8').replace(
    '"name": "CONFLICTS_RATE_LIMITER"',
    '"name": "OTHER_RATE_LIMITER"',
  );
  const rendered = renderWeb({}, config);
  assert.equal(rendered.run.status, 1);
  assert.match(rendered.run.stderr, /missing rate-limit binding CONFLICTS_RATE_LIMITER/);
});
