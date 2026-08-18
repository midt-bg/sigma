#!/usr/bin/env node
// Idempotently ensure the AI-Gateway objects the VOICE lane needs:
//
//   1. the gateway          `sigma-assistant`   (shared with chat — ensure-exists only, never mutate its
//                                                settings here or we clobber chat)
//   2. the custom provider  `bggpt-voice`        (BgGPT Whisper upstream, https://api.bggpt.ai)
//
// Provider-only — NO dynamic routes. We tried dynamic routing (routes `voice` / `voice-fallback`) and
// verified empirically that it CANNOT carry audio: a dynamic route is only invokable via the compat
// `chat/completions` endpoint (`model: dynamic/<route>`), and `compat/audio/transcriptions` is explicitly
// unsupported (Cloudflare `2019`). See ADR-0011. The working path is to call the gateway's PROVIDER
// endpoints directly, each in its native format (code-level, Niki's request path):
//   • primary  POST .../sigma-assistant/custom-bggpt-voice/audio/transcriptions   (multipart, BgGPT key)
//   • fallback POST .../sigma-assistant/workers-ai/@cf/openai/whisper-large-v3-turbo (JSON base64, CF token)
// `workers-ai` is a built-in provider (needs no provisioning), so the only voice-specific object to ensure
// here is the `bggpt-voice` custom provider.
//
// Why this exists — same GitOps rationale as scripts/ensure-kv-namespace.mjs: the provider was first stood
// up by hand in the dashboard; hand state drifts silently and isn't reviewable. `wrangler` cannot touch
// AI Gateway, so this goes straight at the account-scoped REST API.
//
// SAFETY: dry-run by default (prints the exact planned mutations); pass --apply to execute — mirrors
// scripts/bootstrap.mjs. Reads never mutate; only --apply issues POSTs.
//
// usage:  node scripts/ensure-voice-provider.mjs [--apply]
//   env:  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN  (token needs AI Gateway:Edit)
//         VOICE_ASSISTANT_API_KEY                       (optional — see ensureCustomProvider)
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';

export const GATEWAY_ID = 'sigma-assistant';
export const PROVIDER_SLUG = 'bggpt-voice';
export const PROVIDER_NAME = 'BgGPT Voice';
export const PROVIDER_BASE_URL = 'https://api.bggpt.ai';

function summariseErrors(status, body) {
  const errs = Array.isArray(body?.errors) ? body.errors : [];
  // Some endpoints return a flat `{success:false,error:"..."}`, not an errors[] — cover both.
  const flat = typeof body?.error === 'string' ? body.error : '';
  return errs.map((e) => `${e.code} ${e.message}`).join('; ') || flat || `HTTP ${status}`;
}

// One request + uniform error surfacing. Returns the parsed body; callers read `.result`.
async function req(fetchImpl, url, { method = 'GET', token, body } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json();
  if (!res.ok || !parsed.success) {
    throw new Error(`${method} ${url} failed: ${summariseErrors(res.status, parsed)}`);
  }
  return parsed;
}

function requireCreds({ accountId, token }) {
  if (!accountId || !token) {
    throw new Error(
      'ensure-voice-provider: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.',
    );
  }
}

// --- gateway ---------------------------------------------------------------------------------------
// GET /accounts/{a}/ai-gateway/gateways -> { result: [{ id, ... }] }  (verified). Ensure the shared
// gateway exists so the provider invocation path (.../sigma-assistant/...) is valid; chat owns its config.
export async function ensureGateway({
  accountId,
  token,
  gatewayId = GATEWAY_ID,
  fetchImpl = fetch,
}) {
  requireCreds({ accountId, token });
  const list = await req(
    fetchImpl,
    `${API}/accounts/${accountId}/ai-gateway/gateways?per_page=50`,
    {
      token,
    },
  );
  // ponytail: single page — the account holds ~1 gateway. Paginate if that ever grows past 50.
  if ((list.result ?? []).some((g) => g.id === gatewayId)) return gatewayId;
  await req(fetchImpl, `${API}/accounts/${accountId}/ai-gateway/gateways`, {
    method: 'POST',
    token,
    body: { id: gatewayId },
  });
  return gatewayId;
}

// --- custom provider -------------------------------------------------------------------------------
// GET /accounts/{a}/ai-gateway/custom-providers -> { result: [{ id, slug, base_url, headers, ... }] }
// (verified — custom providers are ACCOUNT-scoped, not under a gateway). Auth model: if
// VOICE_ASSISTANT_API_KEY is supplied we store it as the provider's Authorization header; if absent, the
// provider is created key-less (per-request-auth model — the app passes the key, like the chat `bggpt`
// provider) and we warn. Idempotent: when the provider already exists we do NOT re-PUT the secret every
// run (GET masks it, so drift is undetectable) — existence + base_url are enough.
export async function ensureCustomProvider({
  accountId,
  token,
  slug = PROVIDER_SLUG,
  name = PROVIDER_NAME,
  baseUrl = PROVIDER_BASE_URL,
  apiKey,
  fetchImpl = fetch,
  warn = () => {},
}) {
  requireCreds({ accountId, token });
  const list = await req(
    fetchImpl,
    `${API}/accounts/${accountId}/ai-gateway/custom-providers?per_page=50`,
    { token },
  );
  const existing = (list.result ?? []).find((p) => p.slug === slug);
  if (existing) {
    if (existing.base_url && existing.base_url !== baseUrl) {
      warn(`provider "${slug}" base_url is ${existing.base_url}, expected ${baseUrl} — left as-is`);
    }
    return existing.id ?? slug;
  }
  if (!apiKey) {
    warn(
      `VOICE_ASSISTANT_API_KEY not set — creating provider "${slug}" without stored auth (per-request-auth model)`,
    );
  }
  const created = await req(fetchImpl, `${API}/accounts/${accountId}/ai-gateway/custom-providers`, {
    method: 'POST',
    token,
    body: {
      name,
      slug,
      base_url: baseUrl,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : null,
    },
  });
  return created.result?.id ?? slug;
}

// Dry-run decorator: GETs pass through (safe); every mutation is logged as WOULD … and answered with a
// synthetic success so the full plan prints in one pass without touching the account.
export function dryRunFetch(real, log) {
  return async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'GET') return real(url, opts);
    // Mask any bearer secret in the logged body: dry-run is the DEFAULT mode, so a stored `Authorization`
    // header (from VOICE_ASSISTANT_API_KEY) would otherwise print verbatim to stdout / the CI log. Mirrors
    // ensure-worker-secret.mjs, which never lets a secret touch stdout (review, ydimitrof).
    const rawBody = opts.body
      ? typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body)
      : '';
    const safeBody = rawBody.replace(/("Authorization"\s*:\s*")Bearer\s+[^"]+/gi, '$1Bearer ***');
    log(`  WOULD ${method} ${url}${safeBody ? ` ${safeBody}` : ''}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { id: 'DRY-RUN', slug: 'DRY-RUN' } }),
    };
  };
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const apiKey = process.env.VOICE_ASSISTANT_API_KEY;
  const log = (m) => process.stdout.write(`${m}\n`);
  const warn = (m) => process.stderr.write(`!! ${m}\n`);
  const fetchImpl = apply ? fetch : dryRunFetch(fetch, log);

  try {
    requireCreds({ accountId, token });
    log(apply ? '==> Applying AI-Gateway desired state' : '==> Dry run (pass --apply to execute)');

    await ensureGateway({ accountId, token, fetchImpl });
    log(`  gateway    ${GATEWAY_ID} ok`);

    await ensureCustomProvider({ accountId, token, apiKey, fetchImpl, warn });
    log(`  provider   ${PROVIDER_SLUG} ok`);
  } catch (err) {
    warn(err.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
