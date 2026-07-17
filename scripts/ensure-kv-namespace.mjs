#!/usr/bin/env node
// Idempotently ensure a Cloudflare KV namespace with an EXACT title exists; print its id to stdout.
//
// GitOps provisioning for DEDUP_KV — the assistant report-dedup cache (apps/web/workers/assistant/*). The
// KV binding needs a real, account-unique id at `wrangler deploy` (scripts/wrangler-render.mjs substitutes
// it for the committed local-dev placeholder, same pattern as SIGMA_D1_ID). Rather than a human creating
// the namespace once and pasting its id into a secret, CI enforces the desired state from git:
// ensure-then-reference, idempotent, ONE namespace per real environment —
//   • sigma-dedup-dev      shared by the dev env AND every ephemeral per-PR preview
//   • sigma-dedup-staging
//   • sigma-dedup-prod
// The freshness token folded into every dedup key (dedup-request.ts) isolates entries across builds/data
// versions, so a shared dev/preview namespace can never serve one env's report to another. Wired into
// .github/workflows/preview.yml (dev) and deploy.yml (staging/prod).
//
// Why the REST API and not `wrangler kv namespace create`: wrangler derives the title from the worker name
// (`<worker>-<namespace>`), so from a preview worker (`sigma-pr-<n>`) it cannot produce the exact shared
// title `sigma-dedup-dev`. The account-scoped API lets us pin the title and match on it precisely.
//
// usage: node scripts/ensure-kv-namespace.mjs <title>
//   env:    CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN  (token needs Workers KV Storage:Edit)
//   stdout: the 32-hex namespace id, and nothing else — capture it directly:
//             id="$(node scripts/ensure-kv-namespace.mjs sigma-dedup-dev)"
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const PER_PAGE = 100;

// List every KV namespace, paginating to the end. The list endpoint has no server-side title filter and
// Cloudflare does NOT enforce unique titles, so we must see them all: stopping early could miss an existing
// namespace and create a duplicate that silently splits the cache. Returns [{ id, title }].
export async function listNamespaces({ accountId, token, fetchImpl = fetch }) {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await fetchImpl(
      `${API}/accounts/${accountId}/storage/kv/namespaces?per_page=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error(
        `KV namespace list failed (page ${page}): ${summariseErrors(res.status, body)}`,
      );
    }
    const result = Array.isArray(body.result) ? body.result : [];
    out.push(...result.map((n) => ({ id: n.id, title: n.title })));
    if (result.length < PER_PAGE) return out;
  }
}

export async function createNamespace({ accountId, token, title, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API}/accounts/${accountId}/storage/kv/namespaces`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const body = await res.json();
  if (!res.ok || !body.success || !body.result?.id) {
    throw new Error(`KV namespace create "${title}" failed: ${summariseErrors(res.status, body)}`);
  }
  return body.result.id;
}

// Ensure exactly one namespace titled `title` exists; return its id. Idempotent: reuses an existing one,
// only creates when absent. If several already share the title (from a prior partial run) it reuses the
// first and warns — it never adds another, which would split the cache.
export async function ensureNamespace({ accountId, token, title, fetchImpl = fetch }) {
  if (!accountId || !token) {
    throw new Error(
      'ensure-kv-namespace: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.',
    );
  }
  if (!title) throw new Error('ensure-kv-namespace: a namespace <title> is required.');

  const matches = (await listNamespaces({ accountId, token, fetchImpl })).filter(
    (n) => n.title === title,
  );
  if (matches.length > 1) {
    process.stderr.write(
      `!! ${matches.length} KV namespaces share the title "${title}" (${matches
        .map((n) => n.id)
        .join(', ')}); reusing the first. Delete the extras — a split cache defeats dedup.\n`,
    );
  }
  if (matches.length) return matches[0].id;
  return createNamespace({ accountId, token, title, fetchImpl });
}

function summariseErrors(status, body) {
  const errs = Array.isArray(body?.errors) ? body.errors : [];
  return errs.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${status}`;
}

async function main(argv) {
  try {
    const id = await ensureNamespace({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      title: argv[2],
    });
    process.stdout.write(id); // id only, no newline — the workflow captures it into SIGMA_DEDUP_KV_ID
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
