import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  checkCloudflare,
  checkSettings,
  deploySettings,
  EXIT_CODES,
  outcome,
  PROBES,
  readiness,
  readOnlyCloudflare,
  redact,
  runnerContainerClass,
  SETTINGS,
  settingsFromEnv,
  verdict,
} from './release-readiness.mjs';

// Every id, token and salt here is invented.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'tok-INVENTED-0000-readiness-test';
const SALT = 'Zq81kX0pL2mN7vB4cR9tY6wE3uI5oA1sZq81kX0p';
const DB = '11111111-2222-4333-8444-555555555555';
const yaml = readFileSync('.github/workflows/deploy.yml', 'utf8');
const deploy = deploySettings(yaml);
const noLists = { entries: 0, keyVersions: new Set() };

const production = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  SIGMA_D1_ID: DB,
  SIGMA_D1_NAME: 'sigma-blue',
  SUPPRESSION_SALT: SALT,
  SUPPRESSION_KEY_VERSION: '1',
};
const stagingNames = Object.fromEntries(
  deploy.named.map((n) => [n.name, `${n.productionDefault}-stage`]),
);
const staging = {
  ...production,
  ...stagingNames,
  SIGMA_D1_NAME: 'sigma-stage-green',
  SUPPRESSION_SALT: '',
};

const settingsOf = (env) => settingsFromEnv(env, deploy);
const check = (environment, env, { component = 'site', lists = noLists } = {}) =>
  checkSettings({ environment, component, settings: settingsOf(env), deploy, lists });
const failed = (findings) => findings.filter((f) => f.status === 'fail').map((f) => f.subject);
const of = (findings, subject) => findings.filter((f) => f.subject === subject);

test('what deploy.yml reads is taken from deploy.yml', () => {
  assert.deepEqual([...deploy.secrets].sort(), [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'SIGMA_D1_ID',
    'SUPPRESSION_SALT',
  ]);
  assert.ok(deploy.vars.has('SIGMA_D1_NAME') && deploy.vars.has('SUPPRESSION_KEY_VERSION'));
  assert.deepEqual(deploy.required, [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'SIGMA_D1_ID',
  ]);
  assert.deepEqual(deploy.environments, ['staging', 'production']);
  const runnerOnly = deploy.named.filter((n) => n.runnerOnly).map((n) => n.name);
  assert.deepEqual(runnerOnly, [
    'SIGMA_REBUILD_RUNNER_NAME',
    'SIGMA_REBUILD_CUTOVER_WORKFLOW_NAME',
  ]);
  assert.equal(deploy.named.find((n) => n.name === 'SIGMA_WEB_NAME').productionDefault, 'sigma');
  assert.ok(deploy.named.length >= 13);
});

test('every setting deploy.yml reads has a rule here, of the kind deploy.yml reads it as', () => {
  const guarded = new Set(deploy.named.map((n) => n.name));
  for (const name of deploy.secrets) assert.equal(SETTINGS[name], 'secret', name);
  for (const name of deploy.vars)
    assert.ok(SETTINGS[name] === 'var' || guarded.has(name), `${name} has no rule`);
  for (const name of Object.keys(SETTINGS))
    assert.ok(deploy.vars.has(name) || deploy.secrets.has(name), `${name} is no longer read`);
});

test('a setting deploy.yml starts reading without a rule fails the check', () => {
  const grown = deploySettings(
    yaml.replace(
      '      SIGMA_D1_NAME: ${{ vars.SIGMA_D1_NAME }}',
      '      SIGMA_D1_NAME: ${{ vars.SIGMA_D1_NAME }}\n      SIGMA_NEW_THING: ${{ secrets.SIGMA_NEW_THING }}',
    ),
  );
  const findings = checkSettings({
    environment: 'production',
    component: 'site',
    settings: settingsFromEnv(production, grown),
    deploy: grown,
    lists: noLists,
  });
  assert.deepEqual(failed(findings), ['SIGMA_NEW_THING']);
  assert.match(of(findings, 'SIGMA_NEW_THING')[0].text, /does not know what it must hold/);
});

test('commented-out settings and guard lines that check another name are not read', () => {
  const edited = deploySettings(
    yaml
      .replace(
        '      SIGMA_D1_NAME: ${{ vars.SIGMA_D1_NAME }}',
        '      SIGMA_D1_NAME: ${{ vars.SIGMA_D1_NAME }}\n      # SIGMA_OLD: ${{ vars.SIGMA_OLD }}',
      )
      .replace(
        '          check "$SIGMA_WEB_NAME"       sigma           SIGMA_WEB_NAME\n',
        '          check "$SIGMA_WEB_NAME"       sigma           SIGMA_WEB_NAME\n' +
          '          # check "$SIGMA_OLD_NAME" sigma-old SIGMA_OLD_NAME\n' +
          '          check "$SIGMA_ONE_NAME" sigma-one SIGMA_OTHER_NAME\n',
      ),
  );
  assert.ok(!edited.vars.has('SIGMA_OLD'));
  const named = edited.named.map((n) => n.name);
  assert.deepEqual(
    named,
    deploy.named.map((n) => n.name),
  );
});

test('the production defaults the guard holds are the committed names', () => {
  const web = readFileSync('apps/web/wrangler.jsonc', 'utf8');
  const etl = readFileSync('apps/etl/wrangler.toml', 'utf8');
  const runner = readFileSync('apps/etl/wrangler.rebuild-runner.toml', 'utf8');
  const def = (name) => deploy.named.find((n) => n.name === name).productionDefault;
  assert.match(web, new RegExp(`"name": "${def('SIGMA_WEB_NAME')}"`));
  assert.match(web, new RegExp(`"bucket_name": "${def('SIGMA_CSV_CACHE_NAME')}"`));
  assert.match(web, new RegExp(`"bucket_name": "${def('SIGMA_REPORTS_NAME')}"`));
  assert.match(web, new RegExp(`"index_name": "${def('SIGMA_VECTORIZE_NAME')}"`));
  assert.match(etl, new RegExp(`^name = "${def('SIGMA_ETL_NAME')}"`, 'm'));
  assert.match(etl, new RegExp(`bucket_name = "${def('SIGMA_DECLARATIONS_BUCKET')}"`));
  assert.match(runner, new RegExp(`^name = "${def('SIGMA_REBUILD_RUNNER_NAME')}"`, 'm'));
  assert.match(runner, new RegExp(`name = "${def('SIGMA_REBUILD_CUTOVER_WORKFLOW_NAME')}"`));
  assert.equal(runnerContainerClass(), 'DeclarationContainer');
});

test('production with its settings passes the settings part', () => {
  const findings = check('production', production, { component: 'all' });
  assert.deepEqual(failed(findings), []);
  assert.deepEqual(
    findings.filter((f) => f.status === 'warn'),
    [],
  );
});

test('every missing production setting is reported at once, each with where to set it', () => {
  const findings = check('production', {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  });
  assert.deepEqual(failed(findings), ['SIGMA_D1_ID', 'SIGMA_D1_NAME', 'SUPPRESSION_SALT']);
  for (const f of findings.filter((x) => x.status === 'fail'))
    assert.match(f.fix, /GitHub → Settings → Environments → production/, f.subject);
  assert.match(of(findings, 'SUPPRESSION_KEY_VERSION')[0].text, /not set: the deploy uses 1/);
});

test('a salt written from an empty file, a short or a trivial salt is refused, without its value', () => {
  for (const [salt, text] of [
    ['\n', /only whitespace \(written from an empty file\?\)/],
    [' \t\r\n', /only whitespace/],
    ['abcdefgh12345', /shorter than 32 characters/],
    ['0'.repeat(48), /trivial/],
  ]) {
    const findings = check('production', { ...production, SUPPRESSION_SALT: salt });
    assert.deepEqual(failed(findings), ['SUPPRESSION_SALT'], JSON.stringify(salt));
    const [f] = of(findings, 'SUPPRESSION_SALT');
    assert.match(f.text, text);
    assert.match(
      f.fix,
      /openssl rand -hex 32 \| tr -d '\\n' \| gh secret set SUPPRESSION_SALT --env production/,
    );
    if (salt.trim()) assert.ok(!JSON.stringify(findings).includes(salt.trim()), 'never the value');
    assert.doesNotMatch(f.text, /\d+ characters long|length \d/, 'no length beyond ok/too short');
  }
  const padded = of(
    check('production', { ...production, SUPPRESSION_SALT: `${SALT}\n` }),
    'SUPPRESSION_SALT',
  );
  assert.equal(padded[0].status, 'warn');
  assert.match(padded[0].text, /starts or ends with whitespace/);
});

test('staging needs no salt while the takedown lists are empty, and does once they hold entries', () => {
  assert.deepEqual(failed(check('staging', staging)), []);
  const lists = { entries: 2, keyVersions: new Set(['1']) };
  const findings = check('staging', staging, { lists });
  assert.deepEqual(failed(findings), ['SUPPRESSION_SALT']);
  assert.match(of(findings, 'SUPPRESSION_SALT')[0].fix, /secret-rotation\.md/);
});

test('a weak salt only warns where nothing uses it, and fails where something does', () => {
  for (const salt of ['\n', 'changeme', '0'.repeat(48)]) {
    const unused = of(check('staging', { ...staging, SUPPRESSION_SALT: salt }), 'SUPPRESSION_SALT');
    assert.equal(unused[0].status, 'warn', JSON.stringify(salt));
    assert.match(unused[0].text, /not used while the takedown lists are empty/);
    const lists = { entries: 1, keyVersions: new Set(['1']) };
    const used = check('staging', { ...staging, SUPPRESSION_SALT: salt }, { lists });
    assert.deepEqual(failed(used), ['SUPPRESSION_SALT'], JSON.stringify(salt));
    for (const environment of ['production', 'dev2'])
      assert.ok(
        failed(check(environment, { ...production, SUPPRESSION_SALT: salt })).includes(
          'SUPPRESSION_SALT',
        ),
        `${environment} ${JSON.stringify(salt)}`,
      );
  }
});

test('entries fingerprinted under another key version are refused before the build refuses them', () => {
  const lists = { entries: 1, keyVersions: new Set(['2']) };
  const findings = check('production', production, { lists });
  assert.deepEqual(failed(findings), ['SUPPRESSION_KEY_VERSION']);
  assert.match(
    of(findings, 'SUPPRESSION_KEY_VERSION')[1].text,
    /under key version 2, the environment uses 1: every build would refuse/,
  );
  const fixed = check('production', { ...production, SUPPRESSION_KEY_VERSION: '2' }, { lists });
  assert.deepEqual(failed(fixed), []);
  assert.deepEqual(failed(check('production', { ...production, SUPPRESSION_KEY_VERSION: 'v1' })), [
    'SUPPRESSION_KEY_VERSION',
  ]);
});

test('ids of the wrong shape are refused', () => {
  const findings = check('production', {
    ...production,
    CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
    SIGMA_D1_ID: 'sigma-blue',
  });
  assert.deepEqual(failed(findings), ['CLOUDFLARE_ACCOUNT_ID', 'SIGMA_D1_ID']);
  assert.match(of(findings, 'SIGMA_D1_ID')[0].text, /not a database id \(a UUID\)/);
});

test('a non-production environment needs a name of its own for every resource, as the deploy guard does', () => {
  const { SIGMA_ETL_NAME: _omit, ...rest } = staging;
  const findings = check('staging', { ...rest, SIGMA_WEB_NAME: 'sigma' });
  assert.deepEqual(failed(findings), ['SIGMA_WEB_NAME', 'SIGMA_ETL_NAME']);
  assert.match(of(findings, 'SIGMA_WEB_NAME')[0].text, /set to the production name sigma/);
  assert.match(of(findings, 'SIGMA_ETL_NAME')[0].text, /missing: the deploy refuses/);
});

test('the rebuild runner’s names count only for a release that deploys it', () => {
  const { SIGMA_REBUILD_RUNNER_NAME: _a, ...rest } = staging;
  assert.deepEqual(failed(check('staging', rest, { component: 'site' })), []);
  for (const component of ['rebuild-runner', 'all'])
    assert.deepEqual(failed(check('staging', rest, { component })), ['SIGMA_REBUILD_RUNNER_NAME']);
});

test('production renamed away from a committed name is a warning, not a failure', () => {
  const findings = check('production', { ...production, SIGMA_ETL_NAME: 'sigma-etl-x' });
  assert.deepEqual(failed(findings), []);
  assert.equal(of(findings, 'SIGMA_ETL_NAME')[0].status, 'warn');
});

test('dev2 is deployed by hand: its fixes name the shell, not a GitHub environment', () => {
  const findings = check('dev2', { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  for (const f of findings.filter((x) => x.status === 'fail'))
    assert.match(f.fix, /the shell that deploys dev2/, f.subject);
});

// ---------------------------------------------------------------- Cloudflare, over a fake API

const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
const denied = () => ({
  status: 403,
  body: { success: false, errors: [{ code: 9109 }], result: null },
});
const absent = (code = 10006) => ({
  status: 404,
  body: { success: false, errors: [{ code }], result: null },
});

/** A route that fails as the network does: fetch throws. */
const unreachable = Symbol('unreachable');

/** The answers of a Cloudflare where everything a production release needs is there and allowed. */
function cloudflare(overrides = {}) {
  const a = `/accounts/${ACCOUNT}`;
  const routes = {
    [`GET ${a}/tokens/verify`]: ok({ id: 'tokid', status: 'active' }),
    'GET /user/tokens/verify': absent(1000),
    [`GET ${a}`]: ok({ id: ACCOUNT, name: 'Account' }),
    [`GET ${a}/workers/scripts`]: ok([{ id: 'sigma' }, { id: 'sigma-etl' }]),
    [`GET ${a}/workers/scripts/sigma/secrets`]: ok([{ name: 'LOG_IP_KEY', type: 'secret_text' }]),
    [`GET ${a}/workflows`]: ok([]),
    [`GET ${a}/d1/database/${DB}`]: ok({ uuid: DB, name: 'sigma-blue' }),
    [`GET ${a}/d1/database?name=sigma-blue`]: ok([{ uuid: DB, name: 'sigma-blue' }]),
    [`POST ${a}/d1/database/${DB}/query`]: ok([{ results: [{ version: 7 }], success: true }]),
    [`GET ${a}/r2/buckets/sigma-csv-cache`]: ok({ name: 'sigma-csv-cache' }),
    [`GET ${a}/r2/buckets/sigma-reports`]: ok({ name: 'sigma-reports' }),
    [`GET ${a}/r2/buckets/sigma-declarations`]: ok({ name: 'sigma-declarations' }),
    [`GET ${a}/r2/buckets/sigma-declarations/lifecycle`]: ok({ rules: [] }),
    [`GET ${a}/vectorize/v2/indexes/sigma-assistant`]: ok({ name: 'sigma-assistant' }),
    [`GET ${a}/containers/applications`]: ok([{ name: 'sigma-etl-declarationcontainer' }]),
  };
  for (const [key, value] of Object.entries(overrides)) routes[key.replace('{a}', a)] = value;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    calls.push({ method: init.method, path, body: init.body, auth: init.headers.Authorization });
    const answer = routes[`${init.method} ${path}`] ?? {
      status: 500,
      body: { success: false, errors: [] },
    };
    if (answer === unreachable) throw new TypeError(`fetch failed: ${url}`);
    return { status: answer.status, json: async () => answer.body };
  };
  return { fetchImpl, calls };
}

const run = (environment, env, { component = 'site', overrides, now, lists = noLists } = {}) => {
  const api = cloudflare(overrides);
  return readiness({
    environment,
    component,
    env,
    deployYaml: yaml,
    lists,
    fetchImpl: api.fetchImpl,
    codeVersion: 7,
    now: now ?? new Date('2026-11-26T00:00:00Z'),
  }).then((r) => ({ ...r, calls: api.calls }));
};

test('a ready production is READY, and the check only reads', async () => {
  const r = await run('production', production, { component: 'all' });
  assert.equal(r.verdict, 'READY', r.text);
  assert.equal(EXIT_CODES[r.verdict], 0);
  for (const c of r.calls) {
    if (c.method === 'GET') continue;
    assert.equal(c.method, 'POST');
    assert.match(c.path, /\/d1\/database\/[0-9a-f-]+\/query$/);
    assert.equal(JSON.parse(c.body).sql, 'SELECT version FROM data_version WHERE id = 1');
  }
  assert.match(r.text, /^READY — 0 to fix/m);
  assert.match(r.text, /Everything that can be checked without writing passed/);
  const writes = r.findings.filter((f) => f.status === 'write');
  assert.ok(writes.length >= 6);
  for (const f of writes) assert.match(f.text, /cannot be proven without writing/);
  assert.ok(r.findings.some((f) => f.subject === 'rebuild runner' && f.status === 'ok'));
});

test('no setting value reaches the report', async () => {
  for (const environment of ['production', 'staging']) {
    const env = environment === 'production' ? production : { ...staging, SUPPRESSION_SALT: SALT };
    const r = await run(environment, env, {
      component: 'all',
      overrides: {
        [`GET {a}/d1/database/${DB}`]: ok({ uuid: DB, name: 'sigma-green' }),
      },
    });
    for (const secret of [TOKEN, SALT, ACCOUNT, DB])
      assert.ok(!r.text.includes(secret), `${environment} printed a secret`);
    if (environment === 'staging')
      assert.ok(!r.text.includes('sigma-csv-cache-stage'), 'a variable value');
    assert.match(r.text, /SIGMA_D1_ID <SIGMA_D1_ID> is the database sigma-green/);
  }
});

test('a denied permission names the release steps that would fail and what to grant', async () => {
  const r = await run('production', production, {
    overrides: {
      [`GET {a}/d1/database/${DB}`]: denied(),
      [`GET {a}/containers/applications`]: denied(),
    },
  });
  assert.equal(r.verdict, 'NOT READY');
  assert.equal(EXIT_CODES[r.verdict], 1);
  const d1 = r.findings.find((f) => f.subject === 'D1 Edit' && f.status === 'fail');
  assert.match(d1.text, /denied — without it: „Preflight — environment settings and target slot“/);
  assert.match(d1.fix, /give the token D1 Edit/);
  const containers = r.findings.find((f) => f.subject === 'Containers Edit');
  assert.equal(containers.status, 'fail');
  assert.match(containers.text, /„Deploy refresh Workflow \(sigma-etl\)“/);
});

test('an account the token does not reach fails; the slot row claims only the read it proved', async () => {
  const none = await run('production', production, { overrides: { 'GET {a}': absent(7003) } });
  assert.equal(none.verdict, 'NOT READY');
  assert.match(
    none.text,
    /FAIL {2}Account Settings Read — Cloudflare knows no such account for this token/,
  );
  assert.match(none.text, /→ set the id of the account the token belongs to/);
  const ready = await run('production', production);
  const d1 = ready.findings.find(
    (f) => f.subject === 'D1 Edit' && f.probe === PROBES.find((p) => p.id === 'd1').call,
  );
  assert.equal(d1.status, 'write');
  assert.match(d1.text, /^allowed; .*: cannot be proven without writing$/);
});

test('a token without the R2 lifecycle read only warns, as the deploy step does', async () => {
  const r = await run('production', production, {
    overrides: { 'GET {a}/r2/buckets/sigma-declarations/lifecycle': denied() },
  });
  assert.equal(r.verdict, 'READY');
  assert.ok(r.findings.some((f) => f.status === 'warn' && /lifecycle/.test(f.probe)));
});

test('a token that is not accepted, not active or about to expire is reported', async () => {
  const rejected = await run('production', production, {
    overrides: { 'GET {a}/tokens/verify': denied() },
  });
  assert.equal(rejected.verdict, 'NOT READY');
  assert.match(rejected.text, /Cloudflare does not accept the token/);
  assert.equal(rejected.calls.length, 2, 'nothing is probed with a rejected token');

  const user = await run('production', production, {
    overrides: {
      'GET {a}/tokens/verify': absent(1000),
      'GET /user/tokens/verify': ok({ id: 't', status: 'active' }),
    },
  });
  assert.equal(user.verdict, 'READY', 'a user token is verified on its own endpoint');

  const disabled = await run('production', production, {
    overrides: { 'GET {a}/tokens/verify': ok({ id: 't', status: 'disabled' }) },
  });
  assert.match(disabled.text, /FAIL {2}token — the token is disabled, not active/);

  const expiring = await run('production', production, {
    overrides: {
      'GET {a}/tokens/verify': ok({ status: 'active', expires_on: '2026-12-01T00:00:00Z' }),
    },
  });
  assert.equal(expiring.verdict, 'READY');
  assert.match(expiring.text, /warn {2}token — active, but expires 2026-12-01/);
});

test('a token Cloudflare could not be asked about is not checked, never „not accepted“', async () => {
  for (const [why, answer, text] of [
    ['network', unreachable, /open {2}token — not verified: Cloudflare answered nothing/],
    ['429', { status: 429, body: { success: false, errors: [{ code: 971 }] } }, /answered 429/],
    ['503', { status: 503, body: {} }, /answered 503/],
  ]) {
    const r = await run('production', production, {
      overrides: { 'GET {a}/tokens/verify': answer, 'GET /user/tokens/verify': answer },
    });
    assert.equal(r.verdict, 'INCOMPLETE', `${why}: ${r.text}`);
    assert.match(r.text, text, why);
    assert.match(r.text, /→ run the check again/, why);
    assert.doesNotMatch(r.text, /does not accept the token/, why);
    assert.equal(r.calls.length, 2, `${why}: nothing is probed with an unverified token`);
  }
  // An account token is unknown to the user endpoint: its refusal there does not outweigh a 5xx here.
  const mixed = await run('production', production, {
    overrides: {
      'GET {a}/tokens/verify': { status: 502, body: {} },
      'GET /user/tokens/verify': {
        status: 401,
        body: { success: false, errors: [{ code: 1000 }] },
      },
    },
  });
  assert.equal(mixed.verdict, 'INCOMPLETE', mixed.text);
  assert.match(mixed.text, /answered 502/);
});

test('a token Cloudflare refuses, or reports inactive, fails', async () => {
  const invalid = { status: 401, body: { success: false, errors: [{ code: 1000 }] } };
  const refused = await run('production', production, {
    overrides: { 'GET {a}/tokens/verify': invalid, 'GET /user/tokens/verify': invalid },
  });
  assert.equal(refused.verdict, 'NOT READY');
  assert.match(
    refused.text,
    /FAIL {2}token — Cloudflare does not accept the token for this account/,
  );
  const inactive = await run('production', production, {
    overrides: { 'GET {a}/tokens/verify': ok({ id: 't', status: 'expired' }) },
  });
  assert.equal(inactive.verdict, 'NOT READY');
  assert.match(inactive.text, /FAIL {2}token — the token is expired, not active/);
});

test('a name and an id that are not one slot are refused, as the preflight refuses them', async () => {
  const other = await run('production', production, {
    overrides: { [`GET {a}/d1/database/${DB}`]: ok({ uuid: DB, name: 'sigma-green' }) },
  });
  assert.match(
    other.text,
    /FAIL {2}D1 slot — SIGMA_D1_ID <SIGMA_D1_ID> is the database sigma-green, not sigma-blue/,
  );
  const none = await run('production', production, {
    overrides: { [`GET {a}/d1/database/${DB}`]: absent(7404) },
  });
  assert.match(none.text, /FAIL {2}D1 slot — SIGMA_D1_NAME sigma-blue resolves to no database/);
  assert.ok(!none.calls.some((c) => c.method === 'POST'), 'no data version of an unresolved slot');
});

test('the data version is reported, never refused, days before the release', async () => {
  const older = await run('production', production, {
    overrides: { [`POST {a}/d1/database/${DB}/query`]: ok([{ results: [{ version: 6 }] }]) },
  });
  assert.equal(older.verdict, 'READY');
  assert.match(
    older.text,
    /warn {2}data version — sigma-blue holds data version 6, the code computes version 7/,
  );
  const none = await run('production', production, {
    overrides: {
      [`POST {a}/d1/database/${DB}/query`]: {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 7500, message: 'no such table: data_version: SQLITE_ERROR' }],
        },
      },
    },
  });
  assert.match(none.text, /holds data version none/);
  assert.ok(none.findings.some((f) => /query/.test(f.probe ?? '') && f.status === 'write'));
  const same = await run('production', production);
  assert.match(same.text, /ok {4}data version — sigma-blue holds data version 7, the code's/);
});

test('a missing bucket or index fails the site, and the runner creates its own bucket', async () => {
  const site = await run('production', production, {
    overrides: {
      'GET {a}/r2/buckets/sigma-reports': absent(),
      'GET {a}/vectorize/v2/indexes/sigma-assistant': absent(3000),
      'GET {a}/r2/buckets/sigma-declarations': absent(),
    },
  });
  assert.deepEqual(failed(site.findings), [
    'bucket REPORTS',
    'bucket DECLARATIONS_CORPUS',
    'Vectorize index',
  ]);
  assert.match(
    site.text,
    /sigma-reports does not exist: „Deploy explorer \(sigma\)“ would fail binding it/,
  );
  const runner = await run('production', production, {
    component: 'rebuild-runner',
    overrides: { 'GET {a}/r2/buckets/sigma-declarations': absent() },
  });
  assert.equal(runner.verdict, 'READY', runner.text);
  assert.match(
    runner.text,
    /does not exist yet; „Rebuild runner — declarations bucket“ creates it/,
  );
  assert.ok(
    !runner.calls.some((c) => /vectorize|sigma-reports/.test(c.path)),
    'only what it binds',
  );
});

test('a container application left by a removed rebuild runner is caught before Phase 1 stops on it', async () => {
  const left = await run('production', production, {
    component: 'all',
    overrides: {
      'GET {a}/containers/applications': ok([
        { name: 'sigma-rebuild-runner-declarationcontainer' },
      ]),
    },
  });
  assert.deepEqual(failed(left.findings), ['rebuild runner']);
  assert.match(left.text, /would stop with „already an application“/);
  const otherEnvironment = await run('production', production, {
    component: 'all',
    overrides: {
      'GET {a}/containers/applications': ok([
        { name: 'sigma-rebuild-runner-stage-declarationcontainer' },
      ]),
    },
  });
  assert.deepEqual(
    failed(otherEnvironment.findings),
    [],
    'another environment’s runner is not ours',
  );
  const deployed = await run('production', production, {
    component: 'all',
    overrides: { 'GET {a}/workers/scripts': ok([{ id: 'sigma-rebuild-runner' }]) },
  });
  assert.ok(deployed.findings.some((f) => f.subject === 'rebuild runner' && f.status === 'warn'));
});

test('Cloudflare answering something unexpected leaves the probe open: INCOMPLETE', async () => {
  const r = await run('production', production, {
    overrides: { 'GET {a}/workflows': { status: 502, body: {} } },
  });
  assert.equal(r.verdict, 'INCOMPLETE');
  assert.equal(EXIT_CODES[r.verdict], 3);
  assert.match(r.text, /open {2}Workers Scripts Edit — Cloudflare answered 502/);
});

test('without a token nothing is probed and the verdict is INCOMPLETE, not READY', async () => {
  const { CLOUDFLARE_API_TOKEN: _t, ...env } = production;
  const r = await run('production', env);
  assert.equal(r.calls.length, 0);
  assert.equal(r.verdict, 'NOT READY', 'the deploy needs the token');
  const findings = await checkCloudflare({
    environment: 'production',
    component: 'site',
    settings: {},
    deploy,
    cf: null,
  });
  assert.equal(verdict(findings), 'INCOMPLETE');
});

// ---------------------------------------------------------------- the pieces

test('the command takes an environment and --component, nothing else', () => {
  const cli = (...args) =>
    spawnSync(process.execPath, ['scripts/release-readiness.mjs', ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
  for (const args of [
    ['staging', '--settings', 'github'],
    ['staging', '--component'],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /unknown argument/);
    assert.match(r.stderr, /usage: .*\[--component site\|rebuild-runner\|all\]$/m);
  }
  const unknown = cli('stage');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown environment "stage"/);
});

test('the Cloudflare client refuses anything but a read', async () => {
  const seen = [];
  const cf = readOnlyCloudflare({
    token: TOKEN,
    fetchImpl: async (url, init) => (
      seen.push(init.method),
      { status: 200, json: async () => ({ success: true }) }
    ),
  });
  for (const [method, path, body] of [
    ['PUT', `/accounts/${ACCOUNT}/workers/scripts/sigma/secrets`, {}],
    ['DELETE', `/accounts/${ACCOUNT}/r2/buckets/x`],
    ['POST', `/accounts/${ACCOUNT}/d1/database/${DB}/query`, { sql: 'DELETE FROM data_version' }],
    [
      'POST',
      `/accounts/${ACCOUNT}/r2/buckets`,
      { sql: 'SELECT version FROM data_version WHERE id = 1' },
    ],
    [
      'POST',
      `/accounts/${ACCOUNT}/d1/database/${DB}/query/raw`,
      { sql: 'SELECT version FROM data_version WHERE id = 1' },
    ],
  ])
    await assert.rejects(cf(method, path, body), /is not a read/, `${method} ${path}`);
  assert.deepEqual(seen, []);
  await cf('POST', `/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    sql: 'SELECT version FROM data_version WHERE id = 1',
  });
  await cf('GET', `/accounts/${ACCOUNT}`);
  assert.deepEqual(seen, ['POST', 'GET']);
});

test('outcome tells allowed, denied, missing and error apart', () => {
  assert.equal(outcome({ status: 200, success: true }), 'allowed');
  assert.equal(outcome({ status: 403, errors: [{ code: 9109 }] }), 'denied');
  assert.equal(outcome({ status: 401, errors: [{ code: 10000 }] }), 'denied');
  assert.equal(outcome({ status: 401, errors: [] }), 'denied');
  assert.equal(outcome({ status: 403 }), 'denied');
  assert.equal(outcome({ status: 400, errors: [{ code: 10000 }] }), 'denied');
  assert.equal(outcome({ status: 404, errors: [{ code: 10006 }] }), 'missing');
  assert.equal(outcome({ status: 200, success: false }), 'error');
  assert.equal(outcome({ status: 0 }), 'error');
});

test('redaction masks secrets anywhere and variables unless already public', () => {
  const settings = settingsOf({ ...staging, SUPPRESSION_SALT: SALT });
  const text = redact(
    `${TOKEN} ${SALT}x ${DB} sigma-stage-green sigma-csv-cache-stage sigma-csv-cache 1`,
    settings,
    deploy,
  );
  assert.equal(
    text,
    '<CLOUDFLARE_API_TOKEN> <SUPPRESSION_SALT>x <SIGMA_D1_ID> sigma-stage-green <SIGMA_CSV_CACHE_NAME> sigma-csv-cache 1',
  );
  assert.equal(
    redact('sigma-etl-stage-x', settings, deploy),
    'sigma-etl-stage-x',
    'whole names only',
  );
});

test('every probe names deploy.yml steps that exist, and matches the permission table in docs/deploy.md', () => {
  const steps = new Set([...yaml.matchAll(/\n {6}- name: ([^\n]+)/g)].map((m) => m[1].trim()));
  for (const p of PROBES)
    for (const s of p.steps) assert.ok(steps.has(s), `${p.id}: no step „${s}“`);
  const docs = readFileSync('docs/deploy.md', 'utf8');
  const table = docs.slice(docs.indexOf('### Минимални scope-ове за API token'));
  const rows = [
    ...table
      .slice(0, table.indexOf('\n\n', table.indexOf('| право')))
      .matchAll(/^\| ([^|]+?) \*\*(Edit|Read)\*\* \|/gm),
  ].map((m) => `${m[1].trim()} ${m[2]}`);
  assert.deepEqual([...new Set(PROBES.map((p) => p.permission))].sort(), [...rows].sort());
});

test('the readiness workflow is dispatched by hand, reads only, and hands the secrets to one step', () => {
  const wf = readFileSync('.github/workflows/release-readiness.yml', 'utf8');
  const code = wf
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.match(code, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(code, /^\s+(push|pull_request|schedule|workflow_run|pull_request_target):/m);
  assert.match(code, /^permissions:\n {2}contents: read\n\njobs:/m);
  // The environment's reviewers and secrets, without a deployment in its history.
  assert.match(
    code,
    /\n {4}environment:\n {6}name: \$\{\{ inputs\.environment \}\}\n {6}deployment: false\n/,
  );
  assert.doesNotMatch(code, /pnpm|npm (ci|install)|wrangler/, 'no dependency near the secrets');
  // The same settings the deploy reads, no more and no fewer.
  const read = (kind, text) =>
    new Set([...text.matchAll(new RegExp(`\\b${kind}\\.([A-Z][A-Z0-9_]*)`, 'g'))].map((m) => m[1]));
  assert.deepEqual([...read('vars', code)].sort(), [...deploy.vars].sort());
  assert.deepEqual([...read('secrets', code)].sort(), [...deploy.secrets].sort());
  // Secrets only in the step that runs the check.
  const [job, ...steps] = code.slice(code.indexOf('\n  check:')).split('\n      - ');
  assert.doesNotMatch(job, /secrets\./);
  const withSecrets = steps.filter((s) => /secrets\./.test(s));
  assert.equal(withSecrets.length, 1);
  assert.match(
    withSecrets[0],
    /run: node scripts\/release-readiness\.mjs "\$READINESS_ENVIRONMENT" --component "\$READINESS_COMPONENT"/,
  );
  assert.doesNotMatch(code, /run:[^\n]*\$\{\{/, 'inputs reach the shell through env, never inline');
  // Actions pinned to the same commits the deploy uses.
  const uses = [...code.matchAll(/uses: ([^@\s]+)@(\S+)/g)];
  assert.ok(uses.length >= 2);
  for (const [, action, ref] of uses) {
    assert.match(ref, /^[0-9a-f]{40}$/, action);
    assert.ok(yaml.includes(`${action}@${ref}`), `${action} pinned as in deploy.yml`);
  }
  assert.match(code, /persist-credentials: false/);
});
