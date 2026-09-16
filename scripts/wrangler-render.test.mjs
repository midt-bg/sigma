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
  await import(`./wrangler-render.mjs?test=${Date.now()}`);
  const rendered = readFileSync(join(dir, 'wrangler.deploy.toml'), 'utf8');
  assert.match(rendered, /^DECLARATIONS_BUCKET = "sigma-declarations-stage"$/m);
  assert.match(rendered, /^SIGMA_D1_ID = "11111111-2222-4333-8444-555555555555"$/m);
  assert.match(rendered, /^SIGMA_D1_NAME = "sigma-stage-green"$/m);
  assert.match(rendered, /^SIGMA_SHIP_ENV = "staging"$/m);
  assert.match(rendered, /^database_name = "sigma-stage-green"$/m);
  assert.match(rendered, /binding = "DECLARATIONS_RUN"\nname = "sigma-declarations-stage"/);
  assert.match(rendered, /^bucket_name = "sigma-declarations-stage"$/m);
});
