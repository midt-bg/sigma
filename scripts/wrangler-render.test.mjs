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
