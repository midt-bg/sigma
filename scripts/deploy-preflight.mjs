#!/usr/bin/env node
// Before a deploy writes anything: the environment's settings and the slot they name (docs/deploy.md,
// „Проверка преди запис“).
//
//   node scripts/deploy-preflight.mjs <environment> [--component site|rebuild-runner]
//     environment: production | staging | dev2
//
// Reads SIGMA_D1_NAME, SIGMA_D1_ID, SUPPRESSION_SALT and SUPPRESSION_KEY_VERSION from the environment and
// asks Cloudflare, read only, which database the name resolves to, which data version it holds and whether
// a refresh is writing to it (awaitIdleRefresh).
//
// A release once went out with an environment still configured for the previous version: no database name
// (so the declarations never published), no takedown salt (so the first takedown would block every build),
// and nothing that compared the rows in the slot with the rules of the code about to serve them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleepSync } from './d1-retry.mjs';
import { parseJsonObject } from './release-schema.mjs';
import { parseWranglerJson } from './ship-related-persons.mjs';

const root = resolve(import.meta.dirname, '..');

/**
 * Where each environment may deploy, and whether it is held to the production rules. Dev2 is held to them
 * on purpose: it rehearses the production path through this very code.
 */
export const RELEASE_ENVIRONMENTS = {
  production: { slots: ['sigma-blue', 'sigma-green'], strict: true },
  staging: { slots: ['sigma-stage-blue', 'sigma-stage-green'], strict: false },
  dev2: { slots: ['sigma-dev2-blue', 'sigma-dev2-green'], strict: true },
};

/** The rules version of this code (packages/db/data-version.json). */
export function codeDataVersion() {
  return JSON.parse(readFileSync(resolve(root, 'packages/db/data-version.json'), 'utf8')).version;
}

/**
 * The shortest takedown salt accepted as a key. The salt keys HMAC-SHA256 fingerprints of the takedown lists
 * (scripts/cacbg/suppressions.mjs); 32 characters are 128 bits as hex, and the documented way to make one,
 * `openssl rand -hex 32`, gives 64.
 */
export const SALT_MIN_LENGTH = 32;

/**
 * What the takedown salt looks like, without saying anything about its value: `missing`, `blank` (only
 * whitespace — a secret written from an empty file or a lone newline), `short` (under SALT_MIN_LENGTH),
 * `trivial` (fewer than eight distinct characters, a placeholder such as a run of zeros), `padded` (usable,
 * but starting or ending with whitespace, so a fingerprint computed from a copy without it will not match) or
 * `ok`.
 */
export function saltVerdict(salt) {
  if (salt === undefined || salt === null || salt === '') return 'missing';
  const core = salt.trim();
  if (!core) return 'blank';
  if (core.length < SALT_MIN_LENGTH) return 'short';
  if (new Set(core).size < 8) return 'trivial';
  return core === salt ? 'ok' : 'padded';
}

/** SIGMA_D1_NAME against the environment's slots: a failure, or null when it names one of them. */
export function slotNameFailure(environment, name) {
  const policy = RELEASE_ENVIRONMENTS[environment];
  if (!name) return `SIGMA_D1_NAME is not set for ${environment}: name the slot the deploy writes`;
  if (!policy.slots.includes(name))
    return `SIGMA_D1_NAME ${name} is not a ${environment} slot (${policy.slots.join(', ')})`;
  return null;
}

/**
 * The name and the id are one setting in two places; a pair that disagrees writes somewhere unintended.
 * `resolved` is what Cloudflare answers for the pair: the id the name resolves to and the name of that id.
 */
export function resolutionFailure({ name, id, resolved }) {
  if (resolved.id !== id)
    return `SIGMA_D1_NAME ${name} resolves to ${resolved.id || 'no database'}, but SIGMA_D1_ID is another id: set the two together`;
  if (resolved.name !== name)
    return `SIGMA_D1_ID ${id} is the database ${resolved.name || 'with no name'}, not ${name}: set the two together`;
  return null;
}

/** The slot holds rows of another rules version than the code computes. */
export function dataVersionMessage(name, held, codeVersion) {
  return (
    `${name} holds data version ${held ?? 'none'}, the code computes version ${codeVersion}: ` +
    'rows built by other rules are not released over in place — build the idle slot and switch ' +
    '(docs/deploy.md, „Три пътя за пускане“)'
  );
}

/**
 * The checks, over injected reads, so every refusal is tested without Cloudflare. `resolveDatabase(name)` answers
 * the id `wrangler d1 info` resolves the name to and the name Cloudflare gives that database (both '' when it
 * resolves to none); `readDataVersion()` the version the slot holds
 * (null when it holds none); `readRefreshLease()` the refresh's lease row (awaitIdleRefresh, which `now`
 * and `sleep` are handed to). Returns the failures, which stop the deploy, and the warnings, which do not.
 */
export function preflight({
  environment,
  env,
  resolveDatabase,
  readDataVersion,
  readRefreshLease,
  codeVersion,
  component = 'site',
  now,
  sleep,
  log,
}) {
  const failures = [];
  const warnings = [];
  const policy = RELEASE_ENVIRONMENTS[environment];
  if (!policy) {
    failures.push(
      `unknown environment ${JSON.stringify(environment)}: one of ${Object.keys(RELEASE_ENVIRONMENTS).join(', ')}`,
    );
    return { failures, warnings };
  }
  const name = env.SIGMA_D1_NAME ?? '';
  const slot = slotNameFailure(environment, name);
  if (slot) failures.push(slot);
  if (!env.SIGMA_D1_ID) failures.push(`SIGMA_D1_ID is not set for ${environment}`);
  if (failures.length) return { failures, warnings };

  // `wrangler d1 info <name>` takes the id from the rendered config, which binds the name to SIGMA_D1_ID, so
  // the id it answers is SIGMA_D1_ID whenever a config is there: the check that bites is the NAME Cloudflare
  // gives that id. An environment whose own id is missing falls back to another environment's, and that
  // database answers with its own name.
  const resolution = resolutionFailure({
    name,
    id: env.SIGMA_D1_ID,
    resolved: resolveDatabase(name),
  });
  if (resolution) failures.push(resolution);

  if (policy.strict) {
    const salt = saltVerdict(env.SUPPRESSION_SALT);
    if (salt === 'missing')
      failures.push(
        `SUPPRESSION_SALT is not set for ${environment}: the first takedown would block every build`,
      );
    else if (salt === 'blank')
      failures.push(
        `SUPPRESSION_SALT is only whitespace for ${environment} (written from an empty file?): the first takedown would block every build`,
      );
    else if (salt === 'short' || salt === 'trivial')
      // A salt already in use keys the fingerprints in the lists; replacing it is a coordinated change
      // (docs/runbooks/secret-rotation.md), so the deploy only warns and the readiness check refuses.
      warnings.push(
        `SUPPRESSION_SALT for ${environment} is ${salt === 'short' ? `shorter than ${SALT_MIN_LENGTH} characters` : 'trivial'}: rotate it (docs/runbooks/secret-rotation.md)`,
      );
    if (!/^\d+$/.test(env.SUPPRESSION_KEY_VERSION ?? ''))
      failures.push(`SUPPRESSION_KEY_VERSION is not a number for ${environment}`);
  }
  if (failures.length) return { failures, warnings };

  // The rebuild runner exists to give the idle slot the code's version; the live slot it reads may still
  // hold the previous one, so its deploy does not ask.
  if (component === 'rebuild-runner') return { failures, warnings };
  const held = readDataVersion();
  if (held !== codeVersion)
    (policy.strict ? failures : warnings).push(dataVersionMessage(name, held, codeVersion));
  // Last: the slot is the right one and may be written, so only a running refresh still stands in the way.
  // A warning does not skip it: staging deploys over a slot of another data version, and its refresh runs.
  if (!failures.length)
    failures.push(...awaitIdleRefresh({ readLease: readRefreshLease, now, sleep, log }));
  return { failures, warnings };
}

/** How long a deploy waits for a refresh. One takes one to three minutes; a refresh still writing after ten
 *  is stuck or crawling through an overloaded D1, and the deploy says so instead of hanging. */
export const IDLE_WAIT_MS = 10 * 60_000;
export const IDLE_POLL_MS = 30_000;

/**
 * Whether a refresh is writing to the slot: its lease (refresh_lease) is live. The refresh derives a window
 * in batches, and a deploy between two of them could resume the run on the new code — the run then stops
 * before its next write (apps/etl/src/index.ts), leaving the window half-derived until the next run replays
 * it. The deploy also writes the schema and the curated lists into the slot before it replaces the Worker.
 * So a site deploy goes ahead only on an idle slot.
 *
 * Every environment waits up to IDLE_WAIT_MS, reading the lease every IDLE_POLL_MS, and then refuses.
 * The register and the declarations are not waited for: their writes are per partida / per published
 * generation, survive a replaced Worker (docs/deploy.md), and the register paces itself for hours.
 *
 * `readLease()` answers the row (holder, acquired_at, expires_at) or null. Returns the failures.
 */
export function awaitIdleRefresh({
  readLease,
  now = () => new Date(),
  sleep = sleepSync,
  log = (line) => console.log(line),
}) {
  const deadline = now().getTime() + IDLE_WAIT_MS;
  for (;;) {
    const lease = readLease();
    const at = now();
    // ISO-8601 UTC strings compare as text, as the lease itself compares them. An expired row is what a
    // killed instance leaves behind: the next run takes it over, nothing is writing.
    if (!(lease?.expires_at > at.toISOString())) return [];
    const running =
      `a refresh has been writing to the served database since ${lease.acquired_at} ` +
      `(instance ${lease.holder}, lease renewed until ${lease.expires_at})`;
    if (at.getTime() >= deadline)
      return [
        `${running}, still running after ${IDLE_WAIT_MS / 60_000} minutes: look at the instance ` +
          '(wrangler workflows instances describe) and re-run the deploy once it has ended',
      ];
    log(`preflight: ${running} — waiting for it to finish`);
    sleep(IDLE_POLL_MS);
  }
}

/** wrangler as deploy.yml runs it: answers stdout, throws on a non-zero exit. */
const wranglerCli = (config) => (args) =>
  execFileSync(
    'pnpm',
    ['--filter', '@sigma/web', 'exec', 'wrangler', ...args, '--config', config],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

/**
 * Cloudflare, read only, over `wrangler(args)`. A read that fails for any reason but a table not created
 * yet throws: the deploy stops before it writes, it does not take an unreadable slot for an idle one.
 */
export function wranglerReads(name, wrangler) {
  // One row of the slot, or null when the table is not there yet (the run creates it on first use).
  const readRow = (sql, table) => {
    let out;
    try {
      out = wrangler(['d1', 'execute', name, '--remote', '--json', '--command', sql]);
    } catch (error) {
      // wrangler --json reports an SQL error on stdout.
      if (`${error?.message}${error?.stdout}${error?.stderr}`.includes(`no such table: ${table}`))
        return null;
      throw error;
    }
    return parseWranglerJson(out)[0]?.results?.[0] ?? null;
  };
  return {
    resolveDatabase: (db) => {
      try {
        const info = parseJsonObject(wrangler(['d1', 'info', db, '--json']));
        return { id: info.uuid ?? info.database_id ?? '', name: info.name ?? '' };
      } catch {
        return { id: '', name: '' };
      }
    },
    readDataVersion: () => {
      const row = readRow('SELECT version FROM data_version WHERE id = 1', 'data_version');
      return typeof row?.version === 'number' ? row.version : null;
    },
    readRefreshLease: () =>
      readRow(
        'SELECT holder, acquired_at, expires_at FROM refresh_lease WHERE id = 1',
        'refresh_lease',
      ),
  };
}

function main() {
  const [environment, ...flags] = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = flags.indexOf(name);
    return i >= 0 && flags[i + 1] ? flags[i + 1] : fallback;
  };
  const config = flag('--config', 'wrangler.deploy.jsonc');
  const component = flag('--component', 'site');
  if (!['site', 'rebuild-runner'].includes(component))
    throw new Error(`--component must be site or rebuild-runner, got ${component}`);
  const reads = wranglerReads(process.env.SIGMA_D1_NAME ?? '', wranglerCli(config));
  const { failures, warnings } = preflight({
    environment,
    env: process.env,
    resolveDatabase: reads.resolveDatabase,
    readDataVersion: reads.readDataVersion,
    readRefreshLease: reads.readRefreshLease,
    codeVersion: codeDataVersion(),
    component,
  });
  for (const w of warnings) console.log(`::warning title=Preflight::${w}`);
  for (const f of failures) console.log(`::error title=Preflight::${f}`);
  if (failures.length) {
    console.log(`preflight: REFUSED ${environment} — nothing was written`);
    process.exitCode = 1;
  } else console.log(`preflight: ${environment} OK (${process.env.SIGMA_D1_NAME})`);
}

if (import.meta.main) main();
