#!/usr/bin/env node
// Before a deploy writes anything: the environment's settings and the slot they name (docs/deploy.md,
// „Проверка преди запис“).
//
//   node scripts/deploy-preflight.mjs <environment>     (production | staging | dev2)
//
// Reads SIGMA_D1_NAME, SIGMA_D1_ID, SUPPRESSION_SALT and SUPPRESSION_KEY_VERSION from the environment and
// asks Cloudflare, read only, which database the name resolves to and which data version it holds.
//
// A release once went out with an environment still configured for the previous version: no database name
// (so the declarations never published), no takedown salt (so the first takedown would block every build),
// and nothing that compared the rows in the slot with the rules of the code about to serve them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * The checks, over injected reads, so every refusal is tested without Cloudflare. `resolveId(name)` answers
 * the id the name resolves to ('' when it resolves to none); `readDataVersion()` the version the slot holds
 * (null when it holds none). Returns the failures, which stop the deploy, and the warnings, which do not.
 */
export function preflight({ environment, env, resolveId, readDataVersion, codeVersion }) {
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
  if (!name)
    failures.push(`SIGMA_D1_NAME is not set for ${environment}: name the slot the deploy writes`);
  else if (!policy.slots.includes(name))
    failures.push(
      `SIGMA_D1_NAME ${name} is not a ${environment} slot (${policy.slots.join(', ')})`,
    );
  if (!env.SIGMA_D1_ID) failures.push(`SIGMA_D1_ID is not set for ${environment}`);
  if (failures.length) return { failures, warnings };

  // The name and the id are one setting in two places; a pair that disagrees writes somewhere unintended.
  const resolved = resolveId(name);
  if (resolved !== env.SIGMA_D1_ID)
    failures.push(
      `SIGMA_D1_NAME ${name} resolves to ${resolved || 'no database'}, but SIGMA_D1_ID is another id: set the two together`,
    );

  if (policy.strict) {
    if (!env.SUPPRESSION_SALT)
      failures.push(
        `SUPPRESSION_SALT is not set for ${environment}: the first takedown would block every build`,
      );
    if (!/^\d+$/.test(env.SUPPRESSION_KEY_VERSION ?? ''))
      failures.push(`SUPPRESSION_KEY_VERSION is not a number for ${environment}`);
  }
  if (failures.length) return { failures, warnings };

  const held = readDataVersion();
  if (held !== codeVersion) {
    const message =
      `${name} holds data version ${held ?? 'none'}, the code computes version ${codeVersion}: ` +
      'rows built by other rules are not released over in place — build the idle slot and switch ' +
      '(docs/deploy.md, „Три пътя за пускане“)';
    (policy.strict ? failures : warnings).push(message);
  }
  return { failures, warnings };
}

/** Cloudflare, read only, through the wrangler CLI as deploy.yml runs it. */
function wranglerReads(name, config) {
  const wrangler = (args) =>
    execFileSync(
      'pnpm',
      ['--filter', '@sigma/web', 'exec', 'wrangler', ...args, '--config', config],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  return {
    resolveId: (db) => {
      try {
        const info = parseJsonObject(wrangler(['d1', 'info', db, '--json']));
        return info.uuid ?? info.database_id ?? '';
      } catch {
        return '';
      }
    },
    readDataVersion: () => {
      let out;
      try {
        out = wrangler([
          'd1',
          'execute',
          name,
          '--remote',
          '--json',
          '--command',
          'SELECT version FROM data_version WHERE id = 1',
        ]);
      } catch (error) {
        // wrangler --json reports an SQL error on stdout.
        if (/no such table: data_version/.test(`${error?.message}${error?.stdout}${error?.stderr}`))
          return null;
        throw error;
      }
      const row = parseWranglerJson(out)[0]?.results?.[0];
      return typeof row?.version === 'number' ? row.version : null;
    },
  };
}

function main() {
  const [environment, ...flags] = process.argv.slice(2);
  const i = flags.indexOf('--config');
  const config = i >= 0 ? flags[i + 1] : 'wrangler.deploy.jsonc';
  const reads = wranglerReads(process.env.SIGMA_D1_NAME ?? '', config);
  const { failures, warnings } = preflight({
    environment,
    env: process.env,
    resolveId: reads.resolveId,
    readDataVersion: reads.readDataVersion,
    codeVersion: codeDataVersion(),
  });
  for (const w of warnings) console.log(`::warning title=Preflight::${w}`);
  for (const f of failures) console.log(`::error title=Preflight::${f}`);
  if (failures.length) {
    console.log(`preflight: REFUSED ${environment} — nothing was written`);
    process.exitCode = 1;
  } else console.log(`preflight: ${environment} OK (${process.env.SIGMA_D1_NAME})`);
}

if (import.meta.main) main();
