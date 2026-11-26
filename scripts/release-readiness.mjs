#!/usr/bin/env node
// Days before a release: is the environment ready to be released to? (docs/deploy.md, „Готовност преди
// пускането“)
//
//   node scripts/release-readiness.mjs <environment> [--component site|rebuild-runner|all]
//     environment: production | staging | dev2
//
// Strictly read only. It reports, item by item, present or missing and a shape verdict, never a value:
//   - every setting .github/workflows/deploy.yml reads — the list is read from deploy.yml itself, so a setting
//     the deploy starts reading is either understood here or fails the check;
//   - the takedown salt is not missing, blank (written from an empty file), short or trivial;
//   - for each Cloudflare permission the release path uses, a read-only call that shows it is granted, with
//     the deploy steps that would fail without it. A write cannot be proven by a read: such a row says so.
// The verdict is READY (exit 0), NOT READY (exit 1) or INCOMPLETE (exit 3: nothing failed, but something
// could not be checked from here).
//
// It reads the settings from the process environment, as the deploy hands them to its steps: in
// .github/workflows/release-readiness.yml those of the GitHub environment, run by hand those of the shell.
//
// Why days before: a deploy finds a missing setting one failed run at a time and a missing token permission
// only at the step that needs it, and a secret written from an empty file is set and useless. Reads find all
// of it at once.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  codeDataVersion,
  dataVersionMessage,
  RELEASE_ENVIRONMENTS,
  resolutionFailure,
  SALT_MIN_LENGTH,
  saltVerdict,
  slotNameFailure,
} from './deploy-preflight.mjs';

const root = resolve(import.meta.dirname, '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const COMPONENTS = ['site', 'rebuild-runner', 'all'];
export const TAKEDOWN_LISTS = [
  'scripts/cacbg/link-suppressions.jsonl',
  'scripts/cacbg/link-corrections.jsonl',
];

/**
 * The settings with a rule of their own, by the kind deploy.yml reads them as. The resource names that the
 * deploy's non-production guard checks are understood from that guard; any other setting deploy.yml reads
 * fails the check until it is added here.
 */
export const SETTINGS = {
  CLOUDFLARE_API_TOKEN: 'secret',
  CLOUDFLARE_ACCOUNT_ID: 'secret',
  SIGMA_D1_ID: 'secret',
  SUPPRESSION_SALT: 'secret',
  SIGMA_D1_NAME: 'var',
  SUPPRESSION_KEY_VERSION: 'var',
};

const SHAPES = {
  CLOUDFLARE_ACCOUNT_ID: [/^[0-9a-f]{32}$/, 'an account id (32 hexadecimal characters)'],
  SIGMA_D1_ID: [UUID, 'a database id (a UUID)'],
};

/**
 * The Cloudflare permissions the release path uses (docs/deploy.md, „Минимални scope-ове за API token“), each
 * with the read-only call that probes it and the deploy.yml steps that would fail without it. `write` names
 * what the permission is needed for beyond the read; a read cannot prove that part.
 */
export const PROBES = [
  {
    id: 'account',
    permission: 'Account Settings Read',
    call: 'GET /accounts/{account}',
    steps: [],
    also: 'every wrangler call resolves the account',
    write: null,
    // Only a resource probe takes a 404 as allowed: here it is an account the token does not reach.
    missing: 'Cloudflare knows no such account for this token',
    missingFix: 'set the id of the account the token belongs to as CLOUDFLARE_ACCOUNT_ID',
  },
  {
    id: 'workers',
    permission: 'Workers Scripts Edit',
    call: 'GET /accounts/{account}/workers/scripts',
    steps: [
      'Deploy explorer (sigma)',
      'Deploy refresh Workflow (sigma-etl)',
      'ETL Worker secrets for the declarations container',
      'Deploy the rebuild runner',
      'Rebuild runner secrets',
    ],
    write: 'uploading a Worker and putting its secrets',
  },
  {
    id: 'worker-secrets',
    permission: 'Workers Scripts Edit',
    call: 'GET /accounts/{account}/workers/scripts/{web worker}/secrets',
    steps: ['Initialize LOG_IP_KEY secret if absent'],
    write: 'wrangler secret put',
  },
  {
    id: 'workflows',
    permission: 'Workers Scripts Edit',
    call: 'GET /accounts/{account}/workflows',
    steps: ['Deploy refresh Workflow (sigma-etl)', 'Deploy the rebuild runner'],
    also: 'wrangler workflows trigger / describe in the cutover',
    write: 'deploying a Workflow',
  },
  {
    id: 'd1',
    permission: 'D1 Edit',
    call: 'GET /accounts/{account}/d1/database/{SIGMA_D1_ID}',
    steps: ['Preflight — environment settings and target slot'],
    write: 'the writes to the slot, named in the query row',
  },
  {
    id: 'd1-query',
    permission: 'D1 Edit',
    call: 'POST /accounts/{account}/d1/database/{SIGMA_D1_ID}/query — one SELECT',
    steps: ['Preflight — environment settings and target slot', 'Schema plan'],
    write: 'Schema apply, the seed sync and the declarations container’s ship write to the slot',
  },
  {
    id: 'r2',
    permission: 'Workers R2 Storage Edit',
    call: 'GET /accounts/{account}/r2/buckets/{bucket}',
    steps: ['Deploy explorer (sigma)', 'Deploy refresh Workflow (sigma-etl)'],
    write: 'creating the bucket and the container’s writes to the corpus',
  },
  {
    id: 'r2-lifecycle',
    permission: 'Workers R2 Storage Edit',
    call: 'GET /accounts/{account}/r2/buckets/{declarations bucket}/lifecycle',
    steps: ["Expire the declarations run's leftovers in R2"],
    write: 'adding a lifecycle rule',
    // The step only warns without it; the deploy goes on.
    deniedIs: 'warn',
  },
  {
    id: 'vectorize',
    permission: 'Vectorize Edit',
    call: 'GET /accounts/{account}/vectorize/v2/indexes/{index}',
    steps: ['Deploy explorer (sigma)'],
    write: 'the Edit level the table asks for beyond reading the index',
  },
  {
    id: 'containers',
    permission: 'Containers Edit',
    call: 'GET /accounts/{account}/containers/applications',
    steps: ['Deploy refresh Workflow (sigma-etl)', 'Deploy the rebuild runner'],
    also: 'wrangler containers list / delete in the cutover',
    write: 'pushing the image to the account’s registry and rolling out the application',
  },
];

/** Code lines only: comment lines dropped, as the deploy tests read deploy.yml. */
const codeLines = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

/**
 * What deploy.yml reads, taken from deploy.yml: every `vars.X` and `secrets.X`, the secrets its first guard
 * requires, and the resource names its non-production guard holds to a value of their own — each with the
 * production default it must differ from and whether only the rebuild runner needs it.
 */
export function deploySettings(yaml) {
  const text = codeLines(yaml);
  const names = (kind) =>
    new Set([...text.matchAll(new RegExp(`\\b${kind}\\.([A-Z][A-Z0-9_]*)`, 'g'))].map((m) => m[1]));
  const required = [...text.matchAll(/\[ -z "\$\{([A-Z][A-Z0-9_]*)\}" \]\s*&& missing\+=/g)].map(
    (m) => m[1],
  );
  const named = [];
  let runnerOnly = false;
  for (const line of text.split('\n')) {
    if (/^\s*if \[ "\$SIGMA_COMPONENT" = rebuild-runner \]; then\s*$/.test(line)) runnerOnly = true;
    else if (/^\s*fi\s*$/.test(line)) runnerOnly = false;
    const m = line.match(/^\s*check "\$([A-Z][A-Z0-9_]*)"\s+(\S+)\s+([A-Z][A-Z0-9_]*)\s*$/);
    if (m && m[1] === m[3]) named.push({ name: m[1], productionDefault: m[2], runnerOnly });
  }
  // The environments the deploy can be dispatched to are GitHub Environments; any other is deployed by hand.
  const options = text.match(
    /\n {6}environment:\n(?: {8}[^\n]*\n)*? {8}options:\n((?: {10}- [^\n]+\n)+)/,
  );
  const environments = [...(options?.[1] ?? '').matchAll(/- (\S+)/g)].map((m) => m[1]);
  return { vars: names('vars'), secrets: names('secrets'), required, named, environments };
}

/** The takedown lists in the repo: how many entries and under which key versions they were fingerprinted. */
export function takedownLists(paths = TAKEDOWN_LISTS.map((p) => resolve(root, p))) {
  const keyVersions = new Set();
  let entries = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      entries++;
      keyVersions.add(String(JSON.parse(line).key_version ?? ''));
    }
  }
  return { entries, keyVersions };
}

/** The container class of the rebuild runner, from its committed config. */
export function runnerContainerClass(
  toml = readFileSync(resolve(root, 'apps/etl/wrangler.rebuild-runner.toml'), 'utf8'),
) {
  const block = toml.split(/^\[\[containers\]\]\s*$/m)[1] ?? '';
  const m = block.match(/^\s*class_name\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('apps/etl/wrangler.rebuild-runner.toml has no [[containers]] class_name');
  return m[1];
}

/** The settings as the deploy's steps see them: present when non-empty, with the value for the checks. */
export function settingsFromEnv(env, deploy) {
  const settings = {};
  for (const name of [...deploy.vars, ...deploy.secrets]) {
    const value = env[name] ?? '';
    settings[name] = { present: value !== '', value };
  }
  return settings;
}

function finding(section, subject, status, text, { fix, probe } = {}) {
  return { section, subject, status, text, ...(fix ? { fix } : {}), ...(probe ? { probe } : {}) };
}

/** The settings part: what is present, what is missing, and a shape verdict. */
export function checkSettings({ environment, component, settings, deploy, lists }) {
  const out = [];
  const add = (subject, status, text, fix) =>
    out.push(finding('settings', subject, status, text, { fix }));
  const policy = RELEASE_ENVIRONMENTS[environment];
  const inGitHub = deploy.environments.includes(environment);
  const where = inGitHub
    ? `GitHub → Settings → Environments → ${environment}`
    : `the shell that deploys ${environment}`;
  const get = (name) => settings[name] ?? { present: false, value: '' };
  const guarded = new Set(deploy.named.map((n) => n.name));

  for (const name of [...new Set([...deploy.vars, ...deploy.secrets])].sort())
    if (!(name in SETTINGS) && !guarded.has(name))
      add(
        name,
        'fail',
        'deploy.yml reads it and this check does not know what it must hold',
        'add a rule for it to scripts/release-readiness.mjs',
      );

  for (const name of deploy.required) {
    const setting = get(name);
    const shape = SHAPES[name];
    if (!setting.present)
      add(
        name,
        'fail',
        'missing: the deploy stops at its first guard',
        `set the secret ${name} in ${where}`,
      );
    else if (shape && !shape[0].test(setting.value))
      add(
        name,
        'fail',
        `set, but not ${shape[1]}`,
        `set ${shape[1]} as the secret ${name} in ${where}`,
      );
    else add(name, 'ok', shape ? `set, ${shape[1]}` : 'set');
  }

  const slot = slotNameFailure(environment, get('SIGMA_D1_NAME').value ?? '');
  if (slot)
    add(
      'SIGMA_D1_NAME',
      'fail',
      slot,
      `set the variable SIGMA_D1_NAME in ${where}, always together with SIGMA_D1_ID`,
    );
  else add('SIGMA_D1_NAME', 'ok', `set, a ${environment} slot (${get('SIGMA_D1_NAME').value})`);

  const salt = get('SUPPRESSION_SALT');
  const saltNeeded = policy.strict || lists.entries > 0;
  const saltFix =
    `set a salt of at least ${SALT_MIN_LENGTH} characters in ${where}` +
    (inGitHub
      ? `: openssl rand -hex 32 | tr -d '\\n' | gh secret set SUPPRESSION_SALT --env ${environment}`
      : '') +
    (lists.entries > 0
      ? ' — with entries in the takedown lists, as docs/runbooks/secret-rotation.md says'
      : '');
  if (!salt.present)
    add(
      'SUPPRESSION_SALT',
      saltNeeded ? 'fail' : 'ok',
      saltNeeded
        ? 'missing: the first takedown would block every build'
        : 'not set; not needed while the takedown lists are empty and the environment is not held to the production rules',
      saltNeeded ? saltFix : undefined,
    );
  else {
    const verdict = saltVerdict(salt.value);
    // Where nothing uses the salt yet, a weak one is a warning: it must be replaced before it is used.
    const weak = saltNeeded ? 'fail' : 'warn';
    const unused = saltNeeded
      ? ''
      : '; not used while the takedown lists are empty and the environment is not held to the production rules';
    const text = {
      blank: [weak, `set, but only whitespace (written from an empty file?)${unused}`],
      short: [weak, `set, but shorter than ${SALT_MIN_LENGTH} characters${unused}`],
      trivial: [weak, `set, but trivial (fewer than eight distinct characters)${unused}`],
      padded: [
        'warn',
        'set and long enough, but it starts or ends with whitespace: a fingerprint computed from a copy without it will not match',
      ],
      ok: ['ok', `set, at least ${SALT_MIN_LENGTH} characters`],
    }[verdict];
    add('SUPPRESSION_SALT', text[0], text[1], text[0] === 'ok' ? undefined : saltFix);
  }

  // deploy.yml hands `vars.SUPPRESSION_KEY_VERSION || '1'` on.
  const keyVersion = get('SUPPRESSION_KEY_VERSION').value || '';
  const effective = keyVersion || '1';
  if (!/^\d+$/.test(effective))
    add(
      'SUPPRESSION_KEY_VERSION',
      'fail',
      'set, but not a number',
      `set the variable SUPPRESSION_KEY_VERSION in ${where} to the salt's key version`,
    );
  else {
    add(
      'SUPPRESSION_KEY_VERSION',
      'ok',
      keyVersion ? `set, a number (${keyVersion})` : 'not set: the deploy uses 1',
    );
    const others = [...lists.keyVersions].filter((v) => v !== effective).sort();
    if (others.length)
      add(
        'SUPPRESSION_KEY_VERSION',
        'fail',
        `the takedown lists hold entries fingerprinted under key version ${others.join(', ')}, the environment uses ${effective}: every build would refuse`,
        'set the key version the salt belongs to, or re-fingerprint the entries (docs/runbooks/related-persons-suppression.md)',
      );
  }

  const runner = component !== 'site';
  for (const { name, productionDefault, runnerOnly } of deploy.named) {
    // The slot check above holds SIGMA_D1_NAME to more than „not the production default“.
    if (name === 'SIGMA_D1_NAME' || (runnerOnly && !runner)) continue;
    const setting = get(name);
    if (environment === 'production') {
      if (setting.present && setting.value !== productionDefault)
        add(
          name,
          'warn',
          `set: production deploys under the committed name ${productionDefault}, and this renames it`,
          `remove the variable ${name} from ${where}`,
        );
      else add(name, 'ok', `not set: the committed name ${productionDefault}`);
    } else if (!setting.present || setting.value === productionDefault)
      add(
        name,
        'fail',
        setting.present
          ? `set to the production name ${productionDefault}: the deploy refuses`
          : `missing: the deploy refuses to run ${environment} under the production name ${productionDefault}`,
        `set the variable ${name} in ${where} to this environment's own name`,
      );
    else add(name, 'ok', 'set, not the production name');
  }
  return out;
}

const DENIED_CODES = new Set([9106, 9109, 10000]);

/** What a Cloudflare answer says about the probe: allowed, denied, missing (404) or error. */
export function outcome(answer) {
  if (answer.status >= 200 && answer.status < 300 && answer.success !== false) return 'allowed';
  if (
    answer.status === 401 ||
    answer.status === 403 ||
    (answer.errors ?? []).some((e) => DENIED_CODES.has(e?.code))
  )
    return 'denied';
  if (answer.status === 404) return 'missing';
  return 'error';
}

/**
 * The Cloudflare part: the token, the slot the settings name, the resources the deploy binds, and one
 * read-only probe per permission. `cf(method, path, body)` answers `{ status, success, result, errors }`; null
 * when there is no token to probe with (`why` says so).
 */
export async function checkCloudflare({
  environment,
  component,
  settings,
  deploy,
  cf,
  why = 'no CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in this shell',
  accountId,
  codeVersion,
  containerClass = 'DeclarationContainer',
  now = new Date(),
}) {
  const out = [];
  const add = (section, subject, status, text, extra) =>
    out.push(finding(section, subject, status, text, extra));
  if (!cf) {
    add('cloudflare', 'token', 'open', `not probed: ${why}`, {
      fix: 'export the token and the account id in the shell, or run the workflow',
    });
    return out;
  }
  const call = async (method, path, body) => {
    try {
      return await cf(method, path, body);
    } catch {
      return { status: 0, success: false, result: null, errors: [] };
    }
  };
  const acct = `/accounts/${accountId}`;
  const get = (name) => settings[name] ?? { present: false, value: '' };
  const named = (name) => {
    const fallback = deploy.named.find((n) => n.name === name)?.productionDefault ?? '';
    return get(name).value || fallback;
  };
  // How a resource is named in the report: the committed production name as it is, any other as the setting.
  const shown = (name) => {
    const value = named(name);
    return deploy.named.some((n) => n.name === name && n.productionDefault === value)
      ? value
      : `<${name}>`;
  };

  // An account token is verified on the account, a user token on its own endpoint.
  let verify = await call('GET', `${acct}/tokens/verify`);
  if (outcome(verify) !== 'allowed') {
    const user = await call('GET', '/user/tokens/verify');
    if (outcome(user) !== 'allowed') {
      // Only an answer that refuses the token says it is not accepted; a network failure, a 429 or a 5xx
      // says nothing about it.
      const unanswered = [verify, user].find((a) => outcome(a) === 'error');
      if (unanswered)
        add(
          'cloudflare',
          'token',
          'open',
          `not verified: Cloudflare answered ${unanswered.status || 'nothing'}`,
          { fix: 'run the check again' },
        );
      else
        add(
          'cloudflare',
          'token',
          'fail',
          'Cloudflare does not accept the token for this account',
          {
            fix: 'set a valid token as CLOUDFLARE_API_TOKEN (docs/deploy.md, „Минимални scope-ове за API token“)',
          },
        );
      return out;
    }
    verify = user;
  }
  const status = verify.result?.status;
  const expires = verify.result?.expires_on ? new Date(verify.result.expires_on) : null;
  if (status !== 'active')
    add(
      'cloudflare',
      'token',
      'fail',
      `the token is ${status ?? 'of unknown status'}, not active`,
      {
        fix: 'issue a new token with the permissions below (docs/runbooks/secret-rotation.md)',
      },
    );
  else if (expires && expires - now < 14 * 24 * 3600 * 1000)
    add(
      'cloudflare',
      'token',
      'warn',
      `active, but expires ${expires.toISOString().slice(0, 10)}`,
      {
        fix: 'rotate it before the release (docs/runbooks/secret-rotation.md)',
      },
    );
  else
    add(
      'cloudflare',
      'token',
      'ok',
      `active${expires ? `, expires ${expires.toISOString().slice(0, 10)}` : ', no expiry date'}`,
    );

  const report = (id, answer, okText = 'allowed', subject) => {
    const probe = PROBES.find((p) => p.id === id);
    const label = subject ? `${probe.permission} — ${subject}` : probe.permission;
    const result = outcome(answer);
    const needed = [...probe.steps.map((s) => `„${s}“`), ...(probe.also ? [probe.also] : [])].join(
      ', ',
    );
    if (result === 'missing' && probe.missing)
      add('permissions', label, 'fail', probe.missing, {
        probe: probe.call,
        fix: probe.missingFix,
      });
    else if (result === 'allowed' || result === 'missing') {
      if (probe.write)
        add(
          'permissions',
          label,
          'write',
          `${okText}; ${probe.write}: cannot be proven without writing`,
          { probe: probe.call },
        );
      else add('permissions', label, 'ok', okText, { probe: probe.call });
    } else if (result === 'denied')
      add('permissions', label, probe.deniedIs ?? 'fail', `denied — without it: ${needed}`, {
        probe: probe.call,
        fix: `give the token ${probe.permission} on this account in Cloudflare`,
      });
    else
      add(
        'permissions',
        label,
        'open',
        `Cloudflare answered ${answer.status || 'nothing'}${(answer.errors ?? []).length ? ` (code ${answer.errors.map((e) => e?.code).join(', ')})` : ''}`,
        { probe: probe.call, fix: 'run the check again' },
      );
    return result;
  };

  report('account', await call('GET', acct));
  const scripts = await call('GET', `${acct}/workers/scripts`);
  report('workers', scripts);

  const web = named('SIGMA_WEB_NAME');
  const secrets = await call('GET', `${acct}/workers/scripts/${encodeURIComponent(web)}/secrets`);
  report(
    'worker-secrets',
    secrets,
    outcome(secrets) === 'missing'
      ? `the web Worker ${shown('SIGMA_WEB_NAME')} does not exist yet; the deploy creates it before it lists the secrets`
      : 'allowed',
  );
  report('workflows', await call('GET', `${acct}/workflows`));

  // The slot: the pair the settings name, as the preflight checks it at deploy time, then its data version.
  const name = get('SIGMA_D1_NAME').value ?? '';
  const id = get('SIGMA_D1_ID');
  let database = '';
  if (!slotNameFailure(environment, name)) {
    if (UUID.test(id.value)) {
      const answer = await call('GET', `${acct}/d1/database/${id.value}`);
      const result = report('d1', answer);
      if (result === 'allowed' || result === 'missing') {
        const resolved =
          result === 'allowed'
            ? { id: answer.result?.uuid ?? '', name: answer.result?.name ?? '' }
            : { id: '', name: '' };
        const failure = resolutionFailure({ name, id: id.value, resolved });
        if (failure)
          add('cloudflare', 'D1 slot', 'fail', failure, {
            fix: 'set SIGMA_D1_NAME and SIGMA_D1_ID to the same slot',
          });
        else {
          add('cloudflare', 'D1 slot', 'ok', `SIGMA_D1_ID is the database ${name}`);
          database = id.value;
        }
      }
    }
  }
  if (database) {
    const answer = await call('POST', `${acct}/d1/database/${database}/query`, {
      sql: 'SELECT version FROM data_version WHERE id = 1',
    });
    const noTable = (answer.errors ?? []).some((e) =>
      /no such table: data_version/.test(String(e?.message)),
    );
    const result = report('d1-query', noTable ? { ...answer, status: 200, success: true } : answer);
    if (result === 'allowed') {
      const row = noTable ? undefined : answer.result?.[0]?.results?.[0];
      const held = typeof row?.version === 'number' ? row.version : null;
      if (held === codeVersion)
        add(
          'cloudflare',
          'data version',
          'ok',
          `${name} holds data version ${held}, the code's: a release in place is possible`,
        );
      else
        add(
          'cloudflare',
          'data version',
          'warn',
          `${dataVersionMessage(name, held, codeVersion)}; at the release SIGMA_D1_NAME and SIGMA_D1_ID name the built slot`,
          { fix: 'docs/runbooks/production-cutover.md' },
        );
    }
  }

  // The buckets the Workers bind. The rebuild runner creates the declarations bucket when it is missing.
  const site = component !== 'rebuild-runner';
  const buckets = [
    ...(site
      ? [
          ['CSV_CACHE', 'SIGMA_CSV_CACHE_NAME', 'Deploy explorer (sigma)'],
          ['REPORTS', 'SIGMA_REPORTS_NAME', 'Deploy explorer (sigma)'],
        ]
      : []),
    ['DECLARATIONS_CORPUS', 'SIGMA_DECLARATIONS_BUCKET', 'Deploy refresh Workflow (sigma-etl)'],
  ];
  let corpus = false;
  for (const [binding, setting, step] of buckets) {
    const bucket = named(setting);
    const answer = await call('GET', `${acct}/r2/buckets/${encodeURIComponent(bucket)}`);
    const result = report('r2', answer, 'allowed', binding);
    if (result === 'allowed') {
      add('cloudflare', `bucket ${binding}`, 'ok', `${shown(setting)} exists`);
      if (binding === 'DECLARATIONS_CORPUS') corpus = true;
    } else if (result === 'missing') {
      const created = binding === 'DECLARATIONS_CORPUS' && component !== 'site';
      add(
        'cloudflare',
        `bucket ${binding}`,
        created ? 'ok' : 'fail',
        created
          ? `${shown(setting)} does not exist yet; „Rebuild runner — declarations bucket“ creates it`
          : `${shown(setting)} does not exist: „${step}“ would fail binding it`,
        created ? {} : { fix: `create it: wrangler r2 bucket create ${shown(setting)}` },
      );
    }
  }
  if (corpus) {
    const bucket = named('SIGMA_DECLARATIONS_BUCKET');
    report(
      'r2-lifecycle',
      await call('GET', `${acct}/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`),
    );
  }

  if (site) {
    const index = named('SIGMA_VECTORIZE_NAME');
    const answer = await call('GET', `${acct}/vectorize/v2/indexes/${encodeURIComponent(index)}`);
    const result = report('vectorize', answer);
    if (result === 'allowed')
      add('cloudflare', 'Vectorize index', 'ok', `${shown('SIGMA_VECTORIZE_NAME')} exists`);
    else if (result === 'missing')
      add(
        'cloudflare',
        'Vectorize index',
        'fail',
        `${shown('SIGMA_VECTORIZE_NAME')} does not exist: „Deploy explorer (sigma)“ would fail binding it`,
        {
          fix: 'create it first (apps/web/app/lib/assistant/README.md, „Provisioning gate“)',
        },
      );
  }

  const apps = await call('GET', `${acct}/containers/applications`);
  report('containers', apps);
  if (component !== 'site' && outcome(apps) === 'allowed' && outcome(scripts) === 'allowed') {
    // A removed rebuild runner leaves its container application behind, and the next „Deploy the rebuild
    // runner“ stops on it (docs/runbooks/production-cutover.md, Phase 4).
    const runnerName = named('SIGMA_REBUILD_RUNNER_NAME');
    const deployed = (scripts.result ?? []).some((s) => s?.id === runnerName);
    // Wrangler names a Worker's container application <worker>-<class name in lower case>.
    const application = `${runnerName}-${containerClass.toLowerCase()}`;
    const leftover = (apps.result ?? []).some((a) => a?.name === application);
    if (deployed)
      add(
        'cloudflare',
        'rebuild runner',
        'warn',
        `${shown('SIGMA_REBUILD_RUNNER_NAME')} is deployed: a cutover under way?`,
        {
          fix: 'finish it or remove the runner as Phase 4 of docs/runbooks/production-cutover.md says',
        },
      );
    else if (leftover)
      add(
        'cloudflare',
        'rebuild runner',
        'fail',
        `the container application of a removed ${shown('SIGMA_REBUILD_RUNNER_NAME')} is left: „Deploy the rebuild runner“ would stop with „already an application“`,
        {
          fix: 'wrangler containers list, then wrangler containers delete <its id> (docs/runbooks/production-cutover.md, Phase 4)',
        },
      );
    else add('cloudflare', 'rebuild runner', 'ok', 'not deployed and nothing of it left');
  }
  return out;
}

/** READY when nothing failed and nothing was left open; writes that cannot be proven do not count. */
export function verdict(findings) {
  if (findings.some((f) => f.status === 'fail')) return 'NOT READY';
  if (findings.some((f) => f.status === 'open')) return 'INCOMPLETE';
  return 'READY';
}

export const EXIT_CODES = { READY: 0, 'NOT READY': 1, INCOMPLETE: 3 };

const LABELS = { ok: 'ok  ', fail: 'FAIL', warn: 'warn', open: 'open', write: 'read' };
const SECTIONS = {
  settings: 'Settings',
  cloudflare: 'Cloudflare',
  permissions: 'Token permissions',
};

/** The report as text; `redact` is applied by the caller. */
export function render({ environment, component, findings }) {
  const lines = [
    `Release readiness — ${environment}, component ${component}`,
    'Read only: nothing in Cloudflare or GitHub is written. No value is printed.',
  ];
  for (const [section, title] of Object.entries(SECTIONS)) {
    const rows = findings.filter((f) => f.section === section);
    if (!rows.length) continue;
    lines.push('', title);
    for (const f of rows) {
      lines.push(
        `  ${LABELS[f.status]}  ${f.subject} — ${f.text}${f.probe ? ` [${f.probe}]` : ''}`,
      );
      if (f.fix && f.status !== 'ok' && f.status !== 'write') lines.push(`        → ${f.fix}`);
    }
  }
  const count = (status) => findings.filter((f) => f.status === status).length;
  const result = verdict(findings);
  lines.push(
    '',
    `${result} — ${count('fail')} to fix, ${count('warn')} warning(s), ${count('open')} not checked here, ` +
      `${count('write')} write permission probe(s) that a read cannot prove („read“).`,
  );
  if (result === 'READY') lines.push('Everything that can be checked without writing passed.');
  return `${lines.join('\n')}\n`;
}

/**
 * Masks every secret's value anywhere in the text, and every variable value that is not already public in
 * the repo (a slot or a production default), so that no setting reaches a log.
 */
export function redact(text, settings, deploy) {
  const isPublic = new Set([
    ...Object.values(RELEASE_ENVIRONMENTS).flatMap((e) => e.slots),
    ...deploy.named.map((n) => n.productionDefault),
  ]);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entries = Object.entries(settings)
    .filter(([, s]) => s.value.trim().length >= 4)
    .sort(([, a], [, b]) => b.value.length - a.value.length);
  let out = text;
  for (const [name, s] of entries) {
    if (deploy.secrets.has(name)) out = out.split(s.value).join(`<${name}>`);
    else if (!isPublic.has(s.value) && !/^\d+$/.test(s.value))
      out = out.replace(new RegExp(`(?<![\\w-])${escape(s.value)}(?![\\w-])`, 'g'), `<${name}>`);
  }
  return out;
}

/**
 * Cloudflare over HTTPS, refusing anything but a GET or the one SELECT of the data version: the check
 * cannot write even by mistake.
 */
export function readOnlyCloudflare({ token, fetchImpl = fetch }) {
  return async (method, path, body) => {
    const select =
      method === 'POST' &&
      /^\/accounts\/[0-9a-f]+\/d1\/database\/[0-9a-f-]+\/query$/.test(path) &&
      body?.sql === 'SELECT version FROM data_version WHERE id = 1';
    if (method !== 'GET' && !select) throw new Error(`refused: ${method} is not a read`);
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      // A body that is not JSON says nothing more than the status.
    }
    return {
      status: res.status,
      success: json.success,
      result: json.result,
      errors: json.errors ?? [],
    };
  };
}

/** The whole check over injected reads; returns the findings and the text to print. */
export async function readiness({
  environment,
  component = 'site',
  env,
  deployYaml,
  lists,
  fetchImpl,
  codeVersion,
  containerClass,
  now,
}) {
  if (!RELEASE_ENVIRONMENTS[environment])
    throw new Error(
      `unknown environment ${JSON.stringify(environment)}: one of ${Object.keys(RELEASE_ENVIRONMENTS).join(', ')}`,
    );
  if (!COMPONENTS.includes(component))
    throw new Error(`--component must be one of ${COMPONENTS.join(', ')}, got ${component}`);
  const deploy = deploySettings(deployYaml);
  const settings = settingsFromEnv(env, deploy);
  const findings = checkSettings({ environment, component, settings, deploy, lists });

  const token = settings.CLOUDFLARE_API_TOKEN?.value;
  const accountId = settings.CLOUDFLARE_ACCOUNT_ID?.value;
  const usable = Boolean(token) && /^[0-9a-f]{32}$/.test(accountId ?? '');
  findings.push(
    ...(await checkCloudflare({
      environment,
      component,
      settings,
      deploy,
      cf: usable ? readOnlyCloudflare({ token, fetchImpl }) : null,
      why: token
        ? 'CLOUDFLARE_ACCOUNT_ID is not an account id'
        : 'no CLOUDFLARE_API_TOKEN to probe with',
      accountId,
      codeVersion,
      containerClass,
      now,
    })),
  );
  const text = redact(render({ environment, component, findings }), settings, deploy);
  return { findings, verdict: verdict(findings), text };
}

const USAGE =
  'usage: node scripts/release-readiness.mjs <production|staging|dev2> [--component site|rebuild-runner|all]';

async function main() {
  const [environment, ...flags] = process.argv.slice(2);
  let result;
  try {
    let component = 'site';
    for (let i = 0; i < flags.length; i += 2) {
      if (flags[i] !== '--component' || flags[i + 1] === undefined)
        throw new Error(`unknown argument ${JSON.stringify(flags[i])}`);
      component = flags[i + 1];
    }
    result = await readiness({
      environment,
      component,
      env: process.env,
      deployYaml: readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8'),
      lists: takedownLists(),
      codeVersion: codeDataVersion(),
      containerClass: runnerContainerClass(),
    });
  } catch (error) {
    console.error(`release-readiness: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(result.text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${result.text}\`\`\`\n`);
  process.exitCode = EXIT_CODES[result.verdict];
}

if (import.meta.main) await main();
