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
const run = (environment, env, { resolved = ID, held = 2 } = {}) =>
  preflight({
    environment,
    env,
    resolveId: () => resolved,
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
    resolveId: () => reads++,
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
