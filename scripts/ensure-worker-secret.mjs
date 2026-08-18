#!/usr/bin/env node
// Idempotently ensure a Worker holds a random secret; generate-if-absent, never overwrite.
//
// GitOps provisioning for ASSISTANT_HMAC_KEY — the §9.3 transcript-signing key (ADR-0011/0012,
// apps/web/workers/assistant/transcript-hmac.ts). Like LOG_IP_KEY (deploy.yml) it is a purely internal
// key: it never leaves Cloudflare, only needs to be secret and STABLE across redeploys, and has no
// human-provided value. So CI enforces the desired state from git — ensure-then-reference, idempotent:
//   • absent → generate 256-bit random, `wrangler secret put`
//   • present → leave it UNCHANGED (rotating it every deploy would invalidate every in-flight client
//     transcript at once; the dual-key window in transcript-hmac.ts is for DELIBERATE rotation only)
// A freshly-deployed sigma-pr-<n> preview / blue-green prod worker starts with no secrets, so without
// this step the signer would silently emit unsigned turns and filter-on-ingest would drop the entire
// assistant history (fail-open on preview, fail-closed 503 on production+staging — see gateTranscript).
//
// The key is generated IN-PROCESS and streamed to `wrangler secret put` over stdin — it never touches
// argv, stdout, or a shell variable, so there is nothing to leak and no ::add-mask:: to forget (unlike
// the inline bash form). Wired into .github/workflows/preview.yml (preview) and deploy.yml (staging/prod).
//
// usage: node scripts/ensure-worker-secret.mjs <SECRET_NAME>
//   env:    SIGMA_WEB_NAME  (the target worker script name)
//   The core (ensureSecret) takes injected list/put/generate so it is unit-tested without touching CF;
//   main() wires the real `pnpm --filter @sigma/web exec wrangler` implementations.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 256-bit key as 64 hex chars — matches `openssl rand -hex 32` used for LOG_IP_KEY.
export const generateKey = () => randomBytes(32).toString('hex');

// Ensure `name` exists on `workerName`. Returns { action: 'kept' | 'created' | 'skipped', reason? }.
//   - list throws / returns non-array  → 'skipped' (fail OPEN: a transient wrangler/CF hiccup must not
//     fail an otherwise-good deploy; the runtime gate already fails closed on a missing key in prod)
//   - name already present             → 'kept'   (never overwrite — stability across redeploys)
//   - absent                           → 'created' (generate + put; a put failure PROPAGATES, so a
//                                          genuinely un-provisionable required key fails the deploy loudly)
export async function ensureSecret({
  name,
  workerName,
  listSecrets,
  putSecret,
  generate = generateKey,
}) {
  if (!name) throw new Error('ensure-worker-secret: a <secret-name> is required.');
  if (!workerName)
    throw new Error('ensure-worker-secret: SIGMA_WEB_NAME (worker name) is required.');

  let secrets;
  try {
    secrets = await listSecrets(workerName);
  } catch (err) {
    return { action: 'skipped', reason: `secret list failed: ${err.message}` };
  }
  if (!Array.isArray(secrets)) {
    return { action: 'skipped', reason: 'unexpected secret list output (not an array)' };
  }
  if (secrets.some((s) => s && s.name === name)) {
    return { action: 'kept' };
  }

  await putSecret(workerName, name, generate());
  return { action: 'created' };
}

// Real wrangler wrappers — thin shells over the same CLI the other provisioning steps use.
function wranglerListSecrets(workerName) {
  const out = execFileSync(
    'pnpm',
    [
      '--filter',
      '@sigma/web',
      'exec',
      'wrangler',
      'secret',
      'list',
      '--name',
      workerName,
      '--format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

function wranglerPutSecret(workerName, name, value) {
  execFileSync(
    'pnpm',
    ['--filter', '@sigma/web', 'exec', 'wrangler', 'secret', 'put', name, '--name', workerName],
    { input: value, stdio: ['pipe', 'inherit', 'inherit'] },
  );
}

async function main(argv) {
  try {
    const name = argv[2];
    const workerName = process.env.SIGMA_WEB_NAME;
    const result = await ensureSecret({
      name,
      workerName,
      listSecrets: wranglerListSecrets,
      putSecret: wranglerPutSecret,
    });
    if (result.action === 'skipped') {
      process.stderr.write(
        `::notice::${name}: ${result.reason}; leaving provisioning to a later run.\n`,
      );
    } else if (result.action === 'kept') {
      process.stderr.write(`${name} already exists on ${workerName}; leaving it unchanged.\n`);
    } else {
      process.stderr.write(`${name} generated and set on ${workerName}.\n`);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
