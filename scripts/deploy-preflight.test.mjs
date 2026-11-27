import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitIdleRefresh,
  codeDataVersion,
  IDLE_POLL_MS,
  IDLE_WAIT_MS,
  preflight,
  RELEASE_ENVIRONMENTS,
  SALT_MIN_LENGTH,
  saltVerdict,
  wranglerReads,
} from './deploy-preflight.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const ready = {
  SIGMA_D1_NAME: 'sigma-blue',
  SIGMA_D1_ID: ID,
  SUPPRESSION_SALT: '0123456789abcdef'.repeat(4),
  SUPPRESSION_KEY_VERSION: '1',
};
const run = (environment, env, { resolved = ID, named = env.SIGMA_D1_NAME, held = 2 } = {}) =>
  preflight({
    environment,
    env,
    resolveDatabase: () => ({ id: resolved, name: resolved ? named : '' }),
    readDataVersion: () => held,
    readRefreshLease: () => null,
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

test('a salt written from an empty file is refused; a short one only warns at deploy time', () => {
  for (const salt of [' ', '\n', '\r\n', '\t \n']) {
    const { failures } = run('production', { ...ready, SUPPRESSION_SALT: salt });
    assert.match(failures.join('\n'), /SUPPRESSION_SALT is only whitespace for production/);
  }
  const short = run('production', { ...ready, SUPPRESSION_SALT: 'abcdefgh' });
  assert.deepEqual(short.failures, []);
  assert.match(short.warnings.join('\n'), /shorter than 32 characters: rotate it/);
  const trivial = run('production', { ...ready, SUPPRESSION_SALT: '0'.repeat(64) });
  assert.match(trivial.warnings.join('\n'), /SUPPRESSION_SALT for production is trivial/);
  for (const { warnings, failures } of [short, trivial])
    assert.doesNotMatch([...warnings, ...failures].join('\n'), /abcdefgh|0{8}/, 'never the value');
});

test('the salt verdict tells empty, blank, short, trivial, padded and usable apart', () => {
  const good = 'Zq81kX0pL2mN7vB4cR9tY6wE3uI5oA1s';
  assert.equal(good.length, SALT_MIN_LENGTH);
  assert.equal(saltVerdict(undefined), 'missing');
  assert.equal(saltVerdict(''), 'missing');
  assert.equal(saltVerdict('\n'), 'blank');
  assert.equal(saltVerdict(good.slice(1)), 'short');
  assert.equal(saltVerdict(`  ${good.slice(1)}  `), 'short', 'padding does not count');
  assert.equal(saltVerdict('ab'.repeat(32)), 'trivial');
  assert.equal(saltVerdict('abcdefg'.repeat(5)), 'trivial');
  assert.equal(saltVerdict('abcdefgh'.repeat(4)), 'ok');
  assert.equal(saltVerdict(`${good}\n`), 'padded');
  assert.equal(saltVerdict(good), 'ok');
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
  assert.equal(codeDataVersion(), 8);
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

// The refresh derives a window in batches; a deploy between two of them would derive the rest by other code.
// The guard reads the refresh's lease on the target slot before anything is written.
const T0 = Date.parse('2026-11-26T12:30:40.000Z');
const LIVE = {
  holder: 'wf-refresh-1',
  acquired_at: '2026-11-26T12:30:05.000Z',
  expires_at: '2026-11-26T13:00:30.000Z',
};
/** The guard over a fake clock: `leases` answers one read each (the last repeats), `sleep` moves time. */
function guard(leases) {
  let clock = T0;
  let reads = 0;
  const slept = [];
  const failures = awaitIdleRefresh({
    readLease: () => leases[Math.min(reads++, leases.length - 1)],
    now: () => new Date(clock),
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
    },
    log: () => {},
  });
  return { failures, reads, slept };
}

test('no refresh on the slot, or one whose lease has expired: the deploy goes at once', () => {
  for (const lease of [null, { ...LIVE, expires_at: '2026-11-26T12:00:00.000Z' }])
    assert.deepEqual(guard([lease]), { failures: [], reads: 1, slept: [] });
});

test('the deploy waits for a live refresh to finish, then goes', () => {
  assert.deepEqual(guard([LIVE, LIVE, null]), {
    failures: [],
    reads: 3,
    slept: [IDLE_POLL_MS, IDLE_POLL_MS],
  });
});

test('the deploy gives up after the bound, naming the run', () => {
  const { failures, reads, slept } = guard([LIVE]);
  assert.equal(
    slept.reduce((a, b) => a + b, 0),
    IDLE_WAIT_MS,
  );
  assert.equal(reads, IDLE_WAIT_MS / IDLE_POLL_MS + 1);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /a refresh has been writing to the served database since 2026-11-26T12:30:05.000Z \(instance wf-refresh-1, lease renewed until 2026-11-26T13:00:30.000Z\)/,
  );
  assert.match(failures[0], /still running after 10 minutes/);
});

test('a site deploy asks for the lease last, and only of a slot it may write; the rebuild runner never', () => {
  const ask = (environment, env, extra = {}) => {
    let asked = 0;
    let clock = T0;
    const result = preflight({
      environment,
      env,
      resolveDatabase: () => ({ id: ID, name: env.SIGMA_D1_NAME }),
      readDataVersion: () => 2,
      readRefreshLease: () => (asked++, LIVE),
      codeVersion: 2,
      now: () => new Date(clock),
      sleep: (ms) => (clock += ms),
      log: () => {},
      ...extra,
    });
    return { ...result, asked };
  };
  const polls = IDLE_WAIT_MS / IDLE_POLL_MS + 1;
  // Every environment waits the same: production and Dev2 are not turned away at the first read.
  for (const [environment, name] of [
    ['production', 'sigma-blue'],
    ['dev2', 'sigma-dev2-blue'],
    ['staging', 'sigma-stage-blue'],
  ]) {
    const site = ask(environment, { ...ready, SIGMA_D1_NAME: name });
    assert.equal(site.asked, polls, environment);
    assert.match(site.failures.join('\n'), /instance wf-refresh-1.*still running after 10 minutes/);
  }
  assert.equal(ask('production', ready, { component: 'rebuild-runner' }).asked, 0);
  assert.equal(ask('production', ready, { readDataVersion: () => 1 }).asked, 0);
  assert.equal(ask('production', { ...ready, SUPPRESSION_SALT: '' }).asked, 0);
  // Staging only warns about a slot of another data version — its usual state between a merge that raises
  // the version and the rebuild — and the warning does not let the deploy past a running refresh.
  const stale = ask(
    'staging',
    { ...ready, SIGMA_D1_NAME: 'sigma-stage-blue' },
    {
      readDataVersion: () => 1,
    },
  );
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /holds data version 1, the code computes version 2/);
  assert.equal(stale.asked, polls);
  assert.match(stale.failures.join('\n'), /still running after 10 minutes/);
});

// The reads behind the checks, over a fake wrangler: `answer(sql)` is its stdout, or throws as a failed
// command does.
const reads = (answer) => wranglerReads('sigma-blue', (args) => answer(args.at(-1)));
const rows = (...results) => JSON.stringify([{ results, success: true }]);

test('the slot reads: a row, no row, and a table the run has not created yet', () => {
  assert.deepEqual(reads(() => rows(LIVE)).readRefreshLease(), LIVE);
  assert.equal(reads(() => rows()).readRefreshLease(), null);
  assert.equal(reads(() => rows({ version: 7 })).readDataVersion(), 7);
  assert.equal(reads(() => rows()).readDataVersion(), null);
  const missing = (table) => () => {
    throw Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify({ error: { text: `no such table: ${table}: SQLITE_ERROR` } }),
    });
  };
  assert.equal(reads(missing('refresh_lease')).readRefreshLease(), null);
  assert.equal(reads(missing('data_version')).readDataVersion(), null);
});

test('a slot that cannot be read stops the deploy: an unreadable lease is not an idle slot', () => {
  const down = () => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'D1_ERROR: Network connection lost',
    });
  };
  assert.throws(() => reads(down).readRefreshLease(), /Command failed/);
  assert.throws(() => reads(down).readDataVersion(), /Command failed/);
  // Another table's absence is not this one's.
  const other = () => {
    throw Object.assign(new Error('Command failed'), { stdout: 'no such table: data_version' });
  };
  assert.throws(() => reads(other).readRefreshLease(), /Command failed/);
});

test('the deploy runs the guard in the preflight, with no switch that turns the wait off', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(
    yaml,
    /node scripts\/deploy-preflight\.mjs "\$\{\{ needs\.detect\.outputs\.env \}\}" --component "\$SIGMA_COMPONENT"\n/,
  );
  assert.doesNotMatch(yaml, /wait_for_idle|--wait/);
});
