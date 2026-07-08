#!/usr/bin/env node
// Wrangler config renderer. The committed apps/*/wrangler.{toml,jsonc} hold safe zero-UUID
// dummies for the resource IDs (`database_id` for D1, `id` for KV) so `wrangler dev` and the
// vite cloudflare plugin parse cleanly and miniflare keys local state by stable values.
// `wrangler deploy` needs the real IDs — this script substitutes them from env vars and
// writes a sibling `wrangler.deploy.<ext>` that the package `deploy` script passes via
// `--config`. Optional deploy-time name env vars (`SIGMA_WEB_NAME`, `SIGMA_ETL_NAME`,
// `SIGMA_WORKFLOW_NAME`, `SIGMA_D1_NAME`, `SIGMA_CSV_CACHE_NAME`, `SIGMA_REPORTS_NAME`,
// `SIGMA_VECTORIZE_NAME`) explicitly override resource names for alternate environments while
// leaving committed names unchanged when unset.
//
// usage: node scripts/wrangler-render.mjs <path/to/wrangler.toml|jsonc>

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

// Sentinel <- env var. The sentinels appear verbatim in the committed wrangler.* files;
// the values come from the environment at deploy time. Add a row to extend (e.g. a future KV).
const SENTINELS = {
  '00000000-0000-0000-0000-000000000000': 'SIGMA_D1_ID', // D1 database_id (UUID v4 shape)
};

// Required at deploy: every rate limiter the worker relies on must be bound, and Cloudflare requires
// rate-limit namespace_ids to be account-unique — a duplicate silently merges two buckets.
// ASSISTANT_RATE_LIMITER is the most important to assert: unlike the others (which fail OPEN), it fails
// CLOSED in prod, so a dropped/typo'd binding silently 503s every assistant request rather than merely
// disabling a throttle (review #80, follow-up).
const REQUIRED_RATE_LIMITERS = [
  'CSV_RATE_LIMITER',
  'AGG_RATE_LIMITER',
  'SEARCH_RATE_LIMITER',
  'ASSISTANT_RATE_LIMITER',
];

const input = process.argv[2];
if (!input) {
  console.error('usage: wrangler-render.mjs <wrangler.toml|wrangler.jsonc>');
  process.exit(2);
}

const src = readFileSync(input, 'utf8');
let out = src;
const missing = [];
for (const [sentinel, envVar] of Object.entries(SENTINELS)) {
  if (!src.includes(sentinel)) continue;
  const real = process.env[envVar];
  if (!real) {
    missing.push(envVar);
    continue;
  }
  out = out.split(sentinel).join(real);
}

if (missing.length) {
  console.error(`✘ wrangler-render: ${input} needs ${missing.join(', ')}`);
  console.error(
    '  set them in .env.local (then: set -a; source .env.local; set +a) or as repo secrets for CI.',
  );
  process.exit(1);
}

const ext = extname(input);
if (ext === '.json' || ext === '.jsonc') {
  const names = {
    webName: process.env.SIGMA_WEB_NAME || '',
    d1Name: process.env.SIGMA_D1_NAME || '',
    csvCacheName: process.env.SIGMA_CSV_CACHE_NAME || '',
    reportsName: process.env.SIGMA_REPORTS_NAME || '',
    vectorizeName: process.env.SIGMA_VECTORIZE_NAME || '',
  };
  if (
    names.webName ||
    names.d1Name ||
    names.csvCacheName ||
    names.reportsName ||
    names.vectorizeName
  ) {
    out = renderJson(out, names);
  }
  // Most rate limiters fail OPEN at runtime (apps/web/workers/rate-limit.ts), so a missing binding or a
  // namespace_id collision would silently disable a limiter rather than erroring; ASSISTANT_RATE_LIMITER
  // fails CLOSED, where the same misconfig instead 503s the whole endpoint. Catch both here so the deploy
  // fails loudly instead of shipping a silently-broken limiter either way.
  assertRateLimiters(out, input);
} else if (ext === '.toml') {
  const names = {
    etlName: process.env.SIGMA_ETL_NAME || '',
    workflowName: process.env.SIGMA_WORKFLOW_NAME || '',
    d1Name: process.env.SIGMA_D1_NAME || '',
  };
  if (names.etlName || names.workflowName || names.d1Name) {
    out = renderToml(out, names);
  }
}

const outPath = join(dirname(input), basename(input).replace(/^wrangler\./, 'wrangler.deploy.'));
writeFileSync(outPath, out);
console.log(`wrangler-render: ${input} → ${outPath}`);

function assertRateLimiters(text, source) {
  // wrangler.jsonc is JSONC: strip line comments and trailing commas before JSON.parse.
  const obj = JSON.parse(stripJsonLineComments(text).replace(/,(\s*[}\]])/g, '$1'));
  const limiters = (obj.unsafe?.bindings ?? []).filter((b) => b?.type === 'ratelimit');
  const errors = [];

  for (const name of REQUIRED_RATE_LIMITERS) {
    if (!limiters.some((b) => b.name === name)) errors.push(`missing rate-limit binding ${name}`);
  }

  const seen = new Map();
  for (const b of limiters) {
    const id = String(b.namespace_id ?? '').trim();
    if (!id) {
      errors.push(`rate-limit binding ${b.name} has an empty namespace_id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`namespace_id ${id} is shared by ${seen.get(id)} and ${b.name}`);
    } else {
      seen.set(id, b.name);
    }
  }

  if (errors.length) {
    console.error(`✘ wrangler-render: ${source} rate-limit config invalid:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
}

function renderJson(text, names) {
  // JSONC: strip line comments AND trailing commas before JSON.parse (mirrors assertRateLimiters).
  const obj = JSON.parse(stripJsonLineComments(text).replace(/,(\s*[}\]])/g, '$1'));
  if (names.webName) obj.name = names.webName;
  if (names.d1Name && Array.isArray(obj.d1_databases)) {
    for (const db of obj.d1_databases) {
      if (db && typeof db === 'object') db.database_name = names.d1Name;
    }
  }
  if (Array.isArray(obj.r2_buckets)) {
    // Target buckets by BINDING, not blanket: a single name var must not rename every bucket
    // (e.g. staging's SIGMA_CSV_CACHE_NAME would otherwise clobber the REPORTS bucket too).
    for (const bucket of obj.r2_buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (names.csvCacheName && bucket.binding === 'CSV_CACHE')
        bucket.bucket_name = names.csvCacheName;
      if (names.reportsName && bucket.binding === 'REPORTS') bucket.bucket_name = names.reportsName;
    }
  }
  if (names.vectorizeName && Array.isArray(obj.vectorize)) {
    for (const index of obj.vectorize) {
      if (index && typeof index === 'object') index.index_name = names.vectorizeName;
    }
  }
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function stripJsonLineComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function renderToml(text, names) {
  let section = '';
  return text
    .split('\n')
    .map((line) => {
      const sectionMatch = line.match(/^\s*(\[\[?[^\]]+\]?\])\s*$/);
      if (sectionMatch) section = sectionMatch[1];

      if (section === '' && names.etlName) {
        line = replaceTomlStringValue(line, 'name', names.etlName);
      } else if (section === '[[workflows]]' && names.workflowName) {
        line = replaceTomlStringValue(line, 'name', names.workflowName);
      }
      if (names.d1Name) line = replaceTomlStringValue(line, 'database_name', names.d1Name);
      return line;
    })
    .join('\n');
}

function replaceTomlStringValue(line, key, value) {
  return line.replace(
    new RegExp(`^(\\s*${key}\\s*=\\s*")([^"]*)(".*)$`),
    (_match, prefix, _current, suffix) => `${prefix}${escapeTomlBasicString(value)}${suffix}`,
  );
}

function escapeTomlBasicString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
