import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeDataVersion, preflight, RELEASE_ENVIRONMENTS } from './deploy-preflight.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const ready = {
  SIGMA_D1_NAME: 'sigma-blue',
  SIGMA_D1_ID: ID,
  SUPPRESSION_SALT: 'salt',
  SUPPRESSION_KEY_VERSION: '1',
};
const run = (environment, env, { resolved = ID, named = env.SIGMA_D1_NAME, held = 2 } = {}) =>
  preflight({
    environment,
    env,
    resolveDatabase: () => ({ id: resolved, name: resolved ? named : '' }),
    readDataVersion: () => held,
    codeVersion: 2,
  });

test('production with its settings and a slot built by these rules passes', () => {
  assert.deepEqual(run('production', ready), { failures: [], warnings: [] });
});

test('production without a database name is refused — the declarations would never publish', () => {
  const { failures } = run('production', { ...ready, SIGMA_D1_NAME: '' });
  assert.match(failures.join('\n'), /SIGMA_D1_NAME is not set for production/);
});

test('production refuses a name that is not one of its slots', () => {
  for (const name of ['sigma', 'sigma-stage-blue', 'sigma-dev2-blue']) {
    const { failures } = run('production', { ...ready, SIGMA_D1_NAME: name });
    assert.match(failures.join('\n'), /is not a production slot \(sigma-blue, sigma-green\)/, name);
  }
});

test('a name and an id that disagree are refused, in every environment', () => {
  for (const [environment, name] of [
    ['production', 'sigma-green'],
    ['staging', 'sigma-stage-green'],
    ['dev2', 'sigma-dev2-green'],
  ]) {
    const { failures } = run(environment, { ...ready, SIGMA_D1_NAME: name }, { resolved: 'other' });
    assert.match(failures.join('\n'), /resolves to other, but SIGMA_D1_ID is another id/);
  }
  const { failures } = run('production', ready, { resolved: '' });
  assert.match(failures.join('\n'), /resolves to no database/);
});

test('production without the takedown salt or key version is refused', () => {
  assert.match(
    run('production', { ...ready, SUPPRESSION_SALT: '' }).failures.join('\n'),
    /SUPPRESSION_SALT is not set for production: the first takedown would block every build/,
  );
  assert.match(
    run('production', { ...ready, SUPPRESSION_KEY_VERSION: '' }).failures.join('\n'),
    /SUPPRESSION_KEY_VERSION is not a number/,
  );
});

test('production refuses to release in place over rows built by other rules', () => {
  for (const held of [null, 1]) {
    const { failures } = run('production', ready, { held });
    assert.match(
      failures.join('\n'),
      new RegExp(
        `holds data version ${held ?? 'none'}, the code computes version 2: .*build the idle slot and switch`,
      ),
    );
  }
});

test('staging only warns about the data version and needs no salt to deploy', () => {
  const env = { SIGMA_D1_NAME: 'sigma-stage-blue', SIGMA_D1_ID: ID };
  const { failures, warnings } = run('staging', env, { held: null });
  assert.deepEqual(failures, []);
  assert.match(warnings.join('\n'), /holds data version none/);
});

test('Dev2 is held to the production rules, on its own slots', () => {
  assert.equal(RELEASE_ENVIRONMENTS.dev2.strict, true);
  const env = { ...ready, SIGMA_D1_NAME: 'sigma-dev2-blue' };
  assert.deepEqual(run('dev2', env).failures, []);
  assert.match(run('dev2', env, { held: null }).failures.join('\n'), /holds data version none/);
  assert.match(
    run('dev2', { ...env, SIGMA_D1_NAME: 'sigma-green' }).failures.join('\n'),
    /is not a dev2 slot/,
  );
});

test('an unknown environment is refused before anything is read', () => {
  let reads = 0;
  const { failures } = preflight({
    environment: 'prod',
    env: ready,
    resolveDatabase: () => (reads++, { id: '', name: '' }),
    readDataVersion: () => reads++,
    codeVersion: 2,
  });
  assert.match(failures[0], /unknown environment "prod"/);
  assert.equal(reads, 0);
});

test('the code’s data version is the one in packages/db/data-version.json', () => {
  assert.equal(codeDataVersion(), 2);
});

test('the deploy checks the environment before the schema and names the web Worker even unset', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync('.github/workflows/deploy.yml', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const preflightAt = code.indexOf(
    'node scripts/deploy-preflight.mjs "${{ needs.detect.outputs.env }}"',
  );
  assert.ok(preflightAt > 0, 'the deploy runs the preflight');
  assert.ok(preflightAt < code.indexOf('release-schema.mjs plan'), 'before the schema');
  assert.doesNotMatch(code, /--name "\$SIGMA_WEB_NAME"/, 'production leaves SIGMA_WEB_NAME unset');
  assert.match(code, /secret put LOG_IP_KEY --name "\$\{SIGMA_WEB_NAME:-sigma\}"/);
});

test('an id that is another database is refused even when the rendered config makes it resolve', () => {
  // The deploy renders the config from SIGMA_D1_ID, so `wrangler d1 info <name>` answers that very id; only
  // Cloudflare's name for it tells that staging fell back to production's id.
  const env = { SIGMA_D1_NAME: 'sigma-stage-blue', SIGMA_D1_ID: ID };
  const { failures } = run('staging', env, { resolved: ID, named: 'sigma-green' });
  assert.match(
    failures.join('\n'),
    new RegExp(`SIGMA_D1_ID ${ID} is the database sigma-green, not sigma-stage-blue`),
  );
  assert.deepEqual(run('staging', env, { resolved: ID, named: 'sigma-stage-blue' }).failures, []);
});

test('the rebuild runner’s deploy checks the live slot’s settings, not its data version', () => {
  let read = false;
  const result = preflight({
    environment: 'production',
    env: { ...ready, SIGMA_D1_NAME: 'sigma-green' },
    resolveDatabase: () => ({ id: ID, name: 'sigma-green' }),
    readDataVersion: () => {
      read = true;
      return null;
    },
    codeVersion: 2,
    component: 'rebuild-runner',
  });
  assert.deepEqual(result, { failures: [], warnings: [] });
  assert.equal(read, false);
  const noSalt = preflight({
    environment: 'production',
    env: { ...ready, SIGMA_D1_NAME: 'sigma-green', SUPPRESSION_SALT: '' },
    resolveDatabase: () => ({ id: ID, name: 'sigma-green' }),
    readDataVersion: () => null,
    codeVersion: 2,
    component: 'rebuild-runner',
  });
  assert.match(noSalt.failures.join('\n'), /SUPPRESSION_SALT is not set/);
});

test('a rebuild-runner deploy writes nothing of the site, and a site deploy nothing of the runner', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync('.github/workflows/deploy.yml', 'utf8');
  const steps = yaml
    .split('\n      - name: ')
    .slice(1)
    // The comment above a step lands in the block before it: only code counts.
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n'),
    )
    .map((body) => ({
      name: body.split('\n')[0],
      body,
      condition: body.match(/\n {8}if: ([^\n]+)/)?.[1] ?? '',
    }));
  const runner = /rebuild-runner\.toml|r2 bucket create/;
  const site =
    /release-schema\.mjs|run deploy|d1-file\.sh|LOG_IP_KEY|--config wrangler\.deploy\.toml/;
  const runnerSteps = steps.filter((s) => runner.test(s.body));
  const siteSteps = steps.filter((s) => !runner.test(s.body) && site.test(s.body));
  assert.equal(runnerSteps.length, 3);
  assert.ok(siteSteps.length >= 7);
  for (const s of runnerSteps)
    assert.match(s.condition, /env\.SIGMA_COMPONENT == 'rebuild-runner'/, s.name);
  for (const s of siteSteps) assert.match(s.condition, /env\.SIGMA_COMPONENT == 'site'/, s.name);
  assert.match(yaml, /SIGMA_COMPONENT: \$\{\{ inputs\.component \|\| 'site' \}\}/);
});

test('the deploy hands the secrets only to the steps that call Cloudflare', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync('.github/workflows/deploy.yml', 'utf8');
  const [job, ...blocks] = yaml.slice(yaml.indexOf('\n  deploy:')).split('\n      - ');
  assert.doesNotMatch(job, /secrets\./, 'no secret in the job env: pnpm install would see it');
  const steps = blocks.map((block) =>
    block
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n'),
  );
  const calls = /wrangler|run deploy|d1-file\.sh|release-schema|ensure-r2|CLOUDFLARE_API_TOKEN/;
  const salted = /deploy-preflight|SUPPRESSION_SALT/;
  for (const body of steps) {
    const name = body.split('\n')[0];
    const secret = body.match(/\n {8}env: [&*](cloudflare\w*)/)?.[1];
    if (/pnpm install|pnpm typecheck|must not reuse production/.test(body))
      assert.equal(secret, undefined, name);
    else if (salted.test(body)) assert.equal(secret, 'cloudflare_salt', name);
    else if (calls.test(body)) assert.equal(secret, 'cloudflare', name);
  }
  assert.equal(yaml.match(/secrets\.CLOUDFLARE_API_TOKEN/g).length, 2, 'two anchors, no copies');
});
