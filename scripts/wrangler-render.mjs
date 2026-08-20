#!/usr/bin/env node
// Wrangler config renderer. The committed apps/*/wrangler.{toml,jsonc} hold safe zero-UUID
// dummies for the resource IDs (`database_id` for D1, `id` for KV) so `wrangler dev` and the
// vite cloudflare plugin parse cleanly and miniflare keys local state by stable values.
// `wrangler deploy` needs the real IDs — this script substitutes them from env vars and
// writes a sibling `wrangler.deploy.<ext>` that the package `deploy` script passes via
// `--config`. Optional deploy-time name env vars (`SIGMA_WEB_NAME`, `SIGMA_ETL_NAME`,
// `SIGMA_WORKFLOW_NAME`, `SIGMA_D1_NAME`, `SIGMA_CSV_CACHE_NAME`, `SIGMA_REPORTS_NAME`,
// `SIGMA_VECTORIZE_NAME`) explicitly override resource names for alternate environments while
// leaving committed names unchanged when unset. Deploy-time freshness/kill-switch/gate overrides
// (`SIGMA_BUILD_ID`, `SIGMA_ASSISTANT_ENABLED`, `SIGMA_ENVIRONMENT`) stamp the assistant's committed defaults.
//
// usage: node scripts/wrangler-render.mjs <path/to/wrangler.toml|jsonc>

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

// Sentinel <- env var. The sentinels appear verbatim in the committed wrangler.* files;
// the values come from the environment at deploy time. Add a row to extend (e.g. a future KV).
const SENTINELS = {
  '00000000-0000-0000-0000-000000000000': 'SIGMA_D1_ID', // D1 database_id (UUID v4 shape)
  // DEDUP_KV namespace id (32-hex shape). Provisioned idempotently in CI by scripts/ensure-kv-namespace.mjs
  // (one namespace per env — dev shared with previews, staging, prod), which exports SIGMA_DEDUP_KV_ID.
  '00000000000000000000000000000000': 'SIGMA_DEDUP_KV_ID',
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
    // Per-build dedup freshness `c` (commit sha at deploy). Committed value is the constant "dev"; without
    // a real per-build value the dedup cache's code-version leg is dead — a report-shape/FX code change
    // wouldn't bust cached reports, and dev + every preview (which share ONE sigma-dedup-dev namespace and
    // the same dev D1 data version) would compute identical freshness tokens and cross-serve each other's
    // reports. Injecting the sha makes each build's keys distinct, so the shared namespace is safe.
    buildId: process.env.SIGMA_BUILD_ID || '',
    // Master kill switch override (#83). Committed value is "false" (fail dark); an environment opts the
    // assistant IN by setting SIGMA_ASSISTANT_ENABLED (preview + dev = "true"). Unset → committed "false"
    // stays, so staging/production remain dark until deliberately flipped at go-live.
    assistantEnabled: process.env.SIGMA_ASSISTANT_ENABLED || '',
    // Runtime deploy-env binding for the §9.3 HMAC gate (ADR-0012). The gate (gateTranscript) requires a
    // signing key ONLY when ENVIRONMENT ∈ {production, staging} — NOT off import.meta.env.PROD, which Vite
    // inlines true for staging too. Committed value is "development" (fail-open); each target stamps its
    // own name (preview="preview", staging="staging", production="production"). Unset → committed
    // "development" stays, so local `wrangler dev` (no render step) is fail-open by construction.
    environment: process.env.SIGMA_ENVIRONMENT || '',
    // AI-Gateway account id (account-scoped). The committed AI_GATEWAY_BASE_URL / BGGPT_STT_BASE_URL
    // embed one account's id; a target on a DIFFERENT Cloudflare account (e.g. the dev/preview account)
    // stamps its own id here. Unset → the committed URLs are left byte-identical, so production/staging
    // on the original account are unchanged.
    aiGatewayAccount: process.env.SIGMA_AI_GATEWAY_ACCOUNT || '',
    // Public Turnstile site key. Account-bound (the widget lives in one Cloudflare account), so a target
    // on a different account (dev/preview → b2abee…) stamps its own widget's key here. Unset → committed
    // key stays (prod/staging invariant). Pairs with the TURNSTILE_SECRET worker secret for that widget.
    turnstileSiteKey: process.env.SIGMA_TURNSTILE_SITE_KEY || '',
  };
  if (
    names.webName ||
    names.d1Name ||
    names.csvCacheName ||
    names.reportsName ||
    names.vectorizeName ||
    names.buildId ||
    names.assistantEnabled ||
    names.environment ||
    names.aiGatewayAccount ||
    names.turnstileSiteKey
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
    // Per-environment REPORTS R2 bucket — mirrors the JSON/web path's SIGMA_REPORTS_NAME rename. The etl
    // worker PUBLISHES the weekly digest to this bucket; the web worker READS it. Without renaming here,
    // a non-prod deploy would leave etl on the committed `sigma-reports` (the prod bucket) while the web
    // worker's binding is renamed to `sigma-reports-<env>` — a silent split where dev digests land in the
    // prod bucket and the dev web app never sees them. Unset (prod) → committed `sigma-reports` stays, so
    // production carries NO `-dev`/`-<env>` suffix.
    reportsName: process.env.SIGMA_REPORTS_NAME || '',
    // AI-Gateway account id in AI_GATEWAY_BASE_URL — mirrors the JSON/web path's SIGMA_AI_GATEWAY_ACCOUNT
    // swap. The committed URL embeds the prod account; a target on a DIFFERENT Cloudflare account (dev has
    // its own `sigma-assistant` gateway + `custom-bggpt` provider) must stamp its own id, or the etl
    // worker calls the prod account's gateway — which the dev worker's key cannot use, so the digest
    // narrative fails and falls back to AI-free. Unset (prod) → committed URL left byte-identical.
    aiGatewayAccount: process.env.SIGMA_AI_GATEWAY_ACCOUNT || '',
    // Per-environment weekly-digest schedule (e.g. a fast cadence in a data-test env). Rewrites BOTH
    // the DIGEST_CRON var (what scheduled() matches) and the matching [triggers] crons entry (what
    // Cloudflare fires on) from one value, so they cannot drift. Unset → committed "0 7 * * 1" stays.
    digestCron: process.env.SIGMA_DIGEST_CRON || '',
  };
  if (
    names.etlName ||
    names.workflowName ||
    names.d1Name ||
    names.reportsName ||
    names.aiGatewayAccount ||
    names.digestCron
  ) {
    out = renderToml(out, names);
  }
}

const outPath = join(dirname(input), basename(input).replace(/^wrangler\./, 'wrangler.deploy.'));
writeFileSync(outPath, out);
console.log(`wrangler-render: ${input} → ${outPath}`);

// wrangler.jsonc is JSONC: strip full-line comments AND trailing commas before JSON.parse. Both
// renderJson and assertRateLimiters must use this — a plain JSON.parse throws on the committed file's
// trailing commas (this previously crashed renderJson on every renamed-resource deploy).
function parseJsonc(text) {
  return JSON.parse(stripJsonLineComments(text).replace(/,(\s*[}\]])/g, '$1'));
}

function assertRateLimiters(text, source) {
  const obj = parseJsonc(text);
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
  const obj = parseJsonc(text);
  if (names.webName) obj.name = names.webName;
  if (names.d1Name && Array.isArray(obj.d1_databases)) {
    for (const db of obj.d1_databases) {
      if (db && typeof db === 'object') db.database_name = names.d1Name;
    }
  }
  // Rename R2 buckets by BINDING, not position. The web worker now binds two buckets (CSV_CACHE +
  // REPORTS); a blanket loop over r2_buckets would rename BOTH to the CSV value, collapsing REPORTS
  // onto the cache bucket and silently breaking report snapshots. Match each binding to its own env
  // var; an unset var leaves that bucket's committed name untouched (e.g. dev renames CSV_CACHE to
  // sigma-csv-cache-dev but shares the single sigma-reports bucket, so SIGMA_REPORTS_NAME stays unset).
  if ((names.csvCacheName || names.reportsName) && Array.isArray(obj.r2_buckets)) {
    for (const bucket of obj.r2_buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (names.csvCacheName && bucket.binding === 'CSV_CACHE')
        bucket.bucket_name = names.csvCacheName;
      if (names.reportsName && bucket.binding === 'REPORTS') bucket.bucket_name = names.reportsName;
    }
  }
  // Rename the Vectorize index per environment (upstream): isolate each env's index by name.
  if (names.vectorizeName && Array.isArray(obj.vectorize)) {
    for (const index of obj.vectorize) {
      if (index && typeof index === 'object') index.index_name = names.vectorizeName;
    }
  }
  // Stamp the real per-build dedup freshness `c` over the committed "dev" constant.
  if (names.buildId && obj.vars && typeof obj.vars === 'object') obj.vars.BUILD_ID = names.buildId;
  // Opt this environment's assistant IN over the committed fail-dark "false".
  if (names.assistantEnabled && obj.vars && typeof obj.vars === 'object')
    obj.vars.ASSISTANT_ENABLED = names.assistantEnabled;
  // Stamp the runtime deploy-env over the committed "development" so the HMAC gate can tell a public
  // env (production/staging → key required) from an ephemeral one (preview/dev → fail-open).
  if (names.environment && obj.vars && typeof obj.vars === 'object')
    obj.vars.ENVIRONMENT = names.environment;
  // Re-point the AI-Gateway account id in the gateway URLs when deploying to a different account.
  // Swaps only the 32-hex account segment after `.../v1/`, leaving the gateway slug + path intact, so
  // it is agnostic to which account id is committed. Unset → URLs untouched (prod/staging byte-identity).
  if (names.aiGatewayAccount && obj.vars && typeof obj.vars === 'object') {
    for (const key of ['AI_GATEWAY_BASE_URL', 'BGGPT_STT_BASE_URL']) {
      if (typeof obj.vars[key] === 'string') {
        obj.vars[key] = obj.vars[key].replace(
          /(gateway\.ai\.cloudflare\.com\/v1\/)[0-9a-f]{32}/,
          `$1${names.aiGatewayAccount}`,
        );
      }
    }
  }
  // Stamp the per-account Turnstile site key over the committed one (account-bound widget).
  if (names.turnstileSiteKey && obj.vars && typeof obj.vars === 'object')
    obj.vars.TURNSTILE_SITE_KEY = names.turnstileSiteKey;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function stripJsonLineComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function renderToml(text, names) {
  let section = '';
  // Captured from the DIGEST_CRON var in [vars] (which precedes [triggers] in the file), then used to
  // find-and-replace that exact literal inside the crons array — so both move together.
  let committedDigestCron = null;
  // The binding of the [[r2_buckets]] block currently being scanned. In the committed layout `binding`
  // precedes `bucket_name`, so we capture it and rename `bucket_name` only for the matching binding —
  // never by position, which would clobber every bucket (cf. renderJson's same by-binding guard).
  let r2Binding = null;
  const lines = text.split('\n').map((line) => {
    const sectionMatch = line.match(/^\s*(\[\[?[^\]]+\]?\])\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (section === '[[r2_buckets]]') r2Binding = null; // reset per bucket block
    }

    if (section === '' && names.etlName) {
      line = replaceTomlStringValue(line, 'name', names.etlName);
    } else if (section === '[[workflows]]' && names.workflowName) {
      line = replaceTomlStringValue(line, 'name', names.workflowName);
    }
    if (names.d1Name) line = replaceTomlStringValue(line, 'database_name', names.d1Name);

    if (section === '[[r2_buckets]]') {
      const bindingMatch = line.match(/^\s*binding\s*=\s*"([^"]*)"/);
      if (bindingMatch) r2Binding = bindingMatch[1];
      // Only the REPORTS bucket is renamed for the etl worker (it binds no other R2 bucket). Unset
      // reportsName (prod) → the committed bucket_name is left byte-identical, so prod omits the suffix.
      if (r2Binding === 'REPORTS' && names.reportsName) {
        line = replaceTomlStringValue(line, 'bucket_name', names.reportsName);
      }
    }

    // Re-point the AI-Gateway account id in AI_GATEWAY_BASE_URL (same swap renderJson does for the web
    // worker). The regex matches only the 32-hex segment after `.../v1/`, so it touches only the gateway
    // URL line and is agnostic to which account is committed. Unset → URL untouched (prod byte-identity).
    if (names.aiGatewayAccount) {
      line = line.replace(
        /(gateway\.ai\.cloudflare\.com\/v1\/)[0-9a-f]{32}/,
        `$1${names.aiGatewayAccount}`,
      );
    }

    if (names.digestCron) {
      if (section === '[vars]') {
        const varMatch = line.match(/^\s*DIGEST_CRON\s*=\s*"([^"]*)"/);
        if (varMatch) {
          committedDigestCron = varMatch[1];
          line = replaceTomlStringValue(line, 'DIGEST_CRON', names.digestCron);
        }
      } else if (section === '[triggers]' && committedDigestCron && /^\s*crons\s*=/.test(line)) {
        // Function replacement so `$` in the value is never treated as a capture-group reference.
        line = line.replace(
          `"${committedDigestCron}"`,
          () => `"${escapeTomlBasicString(names.digestCron)}"`,
        );
      }
    }
    return line;
  });

  if (names.digestCron && committedDigestCron === null) {
    console.error(
      '✘ wrangler-render: SIGMA_DIGEST_CRON is set but no DIGEST_CRON var exists in [vars]',
    );
    process.exit(1);
  }
  return lines.join('\n');
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
