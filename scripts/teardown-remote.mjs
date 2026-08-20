#!/usr/bin/env node
// Delete a deployed Cloudflare Worker by name. Used to tear down ephemeral per-PR preview workers
// (see .github/workflows/preview.yml) once a pull request closes, and by scripts/reap-previews.mjs to
// enforce the preview max-lifetime. Counterpart to teardown.mjs, which only clears LOCAL miniflare
// state — this one talks to the Cloudflare API and removes a real worker.
//
// usage:
//   node scripts/teardown-remote.mjs --name sigma-pr-123
//   node scripts/teardown-remote.mjs --name sigma-pr-123 --dry-run   (default is to apply)
//
// Deliberately scoped to ephemeral preview workers ONLY. Preview environments share the long-lived dev
// D1 and R2 bucket (read-only from the preview worker's perspective), so there is NO per-PR D1/R2 to
// delete — and we must never delete those shared stores from here. Two barriers enforce this: an
// allowlist (only `sigma-pr-<number>` may be deleted) and an explicit denylist of protected names.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Long-lived workers an ephemeral-cleanup path must NEVER delete, however it is invoked. The allowlist
// below already excludes these; the explicit set is a second barrier and a readable record of intent.
export const PROTECTED = new Set([
  'sigma',
  'sigma-etl',
  'sigma-stage',
  'sigma-etl-stage',
  'sigma-dev',
  'sigma-etl-dev',
]);

// Ephemeral previews are the ONLY workers this script may delete. An allowlist beats the denylist:
// any future long-lived worker is protected automatically without anyone remembering to add it.
export const EPHEMERAL_PREVIEW_RE = /^sigma-pr-\d+$/;

// Cloudflare returns code 10007 / "workers.api.error.script_not_found" when the script is already
// gone. Match the error name, or 10007 only in its `[code: 10007]` shape — a bare `\b10007\b` could
// coincidentally match unrelated numbers in wrangler output and mask a real teardown failure.
const NOT_FOUND = /script_not_found|code:?\s*10007\b/i;

export function isProtected(name) {
  return PROTECTED.has(name);
}

export function isEphemeralPreviewName(name) {
  return typeof name === 'string' && EPHEMERAL_PREVIEW_RE.test(name);
}

// Throws unless `name` is a deletable ephemeral preview worker. Pure — no side effects.
export function assertDeletable(name) {
  if (!name) {
    throw new Error(
      'teardown-remote: a worker name is required (--name <worker> or SIGMA_WEB_NAME).',
    );
  }
  if (isProtected(name)) {
    throw new Error(`teardown-remote: refusing to delete protected long-lived worker "${name}".`);
  }
  if (!isEphemeralPreviewName(name)) {
    throw new Error(
      `teardown-remote: "${name}" is not an ephemeral preview worker (expected sigma-pr-<number>) — refusing to delete.`,
    );
  }
}

// --force avoids the interactive confirmation prompt. Returns wrangler's stdout.
function defaultExec(name) {
  return execFileSync('wrangler', ['delete', '--name', name, '--force'], { encoding: 'utf8' });
}

// Delete one ephemeral preview worker. Returns 'deleted' | 'already-gone' | 'dry-run'.
// Throws via assertDeletable for a protected/invalid name, and rethrows a hard wrangler failure
// (auth, network, wrong account) — those must NOT be swallowed, or a leaked worker goes unnoticed.
export function deleteWorker(name, { dryRun = false, exec = defaultExec } = {}) {
  assertDeletable(name);
  if (dryRun) return 'dry-run';
  try {
    const out = exec(name);
    if (out) process.stdout.write(out);
    return 'deleted';
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`;
    if (output) process.stderr.write(output);
    if (NOT_FOUND.test(output)) return 'already-gone';
    throw err;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const name = flag('--name') || process.env.SIGMA_WEB_NAME;

  try {
    assertDeletable(name);
  } catch (err) {
    console.error(err.message);
    process.exit(name ? 1 : 2);
  }

  console.log(`==> wrangler delete --name ${name}${dryRun ? '  (dry run)' : ''}`);
  try {
    if (deleteWorker(name, { dryRun }) === 'already-gone') {
      console.error(`!! "${name}" not found — already gone; treating teardown as done.`);
    }
  } catch {
    console.error(
      `!! delete of "${name}" failed for a reason other than "not found" — the worker may still be live. ` +
        `Not masking this; failing so it gets surfaced.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
