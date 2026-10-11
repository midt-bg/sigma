import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
