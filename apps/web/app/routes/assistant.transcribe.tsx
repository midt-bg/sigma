// Resource route: the voice-transcription endpoint. The dock POSTs a short base64 audio clip; we
// transcribe it to Bulgarian text and hand it back EDITABLE (never auto-sent). Two server-side Whisper
// providers are tried in order for availability, BOTH routed through the sigma-assistant AI Gateway for
// unified cost/latency observability (ADR-0013):
//   1. BgGPT/INSAIT Whisper (primary) — the custom-bggpt-voice provider (multipart, VOICE key per-request).
//   2. Cloudflare Workers AI Whisper (fallback) — the AI binding, routed through the same gateway.
// Every request carries cf-aig-collect-log:false / collectLog:false so the gateway logs METADATA but NEVER
// the audio — the transient-audio guarantee holds. Which is primary is config-driven via TRANSCRIBE_PRIMARY
// (`bggpt` default, or `workers-ai`). If neither succeeds the dock degrades to the text box (never a dead
// mic). There is deliberately NO browser (Web Speech) tier — inconsistent, and it sends audio to Google.

import type { Route } from './+types/assistant.transcribe';
import { firstPartyRejection } from '../lib/assistant/request-guard';
import { turnstileRejection } from '../lib/assistant/turnstile';
import { assistantEnabled } from '../lib/assistant/enabled';
import { rateLimitBgGptGlobal } from '../../workers/bggpt-global-rate-limit';
import {
  MAX_TRANSCRIBE_BODY_BYTES,
  TRANSCRIBE_LANGUAGE,
  WHISPER_MODEL,
  parseTranscribeBody,
  readCappedText,
  sanitizeTranscript,
} from '../lib/assistant/transcribe';

// Structural type for the Workers AI binding's whisper run — testable with a fake `{ run }`, independent of
// the generated `Ai` type. The gateway option routes the call through the AI Gateway with collectLog:false,
// so metadata is recorded but the audio is never logged.
interface WhisperRunner {
  run(
    model: string,
    inputs: { audio: string; language: string },
    options?: { gateway?: { id: string; collectLog?: boolean } },
  ): Promise<{ text?: unknown }>;
}

// The BgGPT STT base URL is env-only (wrangler.jsonc → BGGPT_STT_BASE_URL = the gateway's custom-bggpt-voice
// provider) — no in-code default, so a missing var SKIPS BgGPT (falls back to Workers AI) rather than baking
// an account-scoped URL into source or silently hitting api.bggpt.ai direct (ADR-0013). The model name is a
// safe non-env default.
const BGGPT_STT_MODEL = 'bggpt-whisper-large-v3';
const UNCONFIGURED = 'Гласовото въвеждане не е конфигурирано.';
const TRANSCRIBE_FAILED = 'Разпознаването на говор не бе успешно.';

type Provider = 'bggpt' | 'workers-ai';
type Attempt = { text: string; source: Provider };

/**
 * BgGPT/INSAIT Whisper (primary) — OpenAI-compatible `POST <base>/audio/transcriptions`, multipart, routed
 * through the AI Gateway (base URL points at the custom-bggpt-voice provider). `cf-aig-collect-log: false`
 * keeps the audio out of the gateway logs. Key stays server-side. Throws on a non-2xx so the route can fall back.
 */
async function transcribeViaBgGpt(
  baseUrl: string,
  key: string,
  model: string,
  audio: string,
  mime: string,
): Promise<string> {
  const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), 'audio');
  form.append('model', model);
  form.append('language', TRANSCRIBE_LANGUAGE);
  form.append('response_format', 'json');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'cf-aig-collect-log': 'false' },
    body: form,
  });
  if (!res.ok) throw new Error(`bggpt stt failed: ${res.status}`);
  const data: unknown = await res.json();
  return typeof data === 'object' &&
    data !== null &&
    'text' in data &&
    typeof data.text === 'string'
    ? data.text
    : '';
}

/**
 * Workers AI Whisper (fallback) — the AI binding routed through the gateway with collectLog:false, so the
 * gateway records metadata but never the audio. Falls back to a direct binding call if no gateway id is set.
 */
async function transcribeViaWorkersAI(
  ai: WhisperRunner,
  audio: string,
  gatewayId: string | undefined,
): Promise<string> {
  const options = gatewayId ? { gateway: { id: gatewayId, collectLog: false } } : undefined;
  const result = await ai.run(WHISPER_MODEL, { audio, language: TRANSCRIBE_LANGUAGE }, options);
  return typeof result.text === 'string' ? result.text : '';
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env;

  // Master kill switch — voice feeds the assistant, so it follows the same launch gate.
  if (!assistantEnabled(env.ASSISTANT_ENABLED)) {
    return Response.json({ error: 'Асистентът не е активен.' }, { status: 503 });
  }

  // First-party guard: audio is posted as application/json (client-side base64), so the JSON content-type
  // IS the CSRF / denial-of-wallet gate — a cross-site fetch forces a preflight we never green-light.
  const rejection = firstPartyRejection({
    method: request.method,
    contentType: request.headers.get('Content-Type'),
    secFetchSite: request.headers.get('Sec-Fetch-Site'),
  });
  if (rejection) return Response.json({ error: rejection.error }, { status: rejection.status });

  const turnstile = await turnstileRejection(request, env, import.meta.env.PROD);
  if (turnstile) return Response.json({ error: turnstile.error }, { status: turnstile.status });

  // Fast-reject an honestly-declared over-cap body, then a CAPPED STREAMING read is the real bound: it
  // aborts past the cap, so an absent/understated Content-Length can't force buffering the whole body.
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSCRIBE_BODY_BYTES) {
    return Response.json({ error: 'аудиото е твърде голямо' }, { status: 413 });
  }
  const raw = await readCappedText(request, MAX_TRANSCRIBE_BODY_BYTES);
  if (raw === null) {
    return Response.json({ error: 'аудиото е твърде голямо' }, { status: 413 });
  }

  const body = parseTranscribeBody(raw);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });

  // Providers, both routed through the AI Gateway: BgGPT (via VOICE_ASSISTANT_API_KEY) primary, Workers AI
  // (AI binding) fallback. At least one must be provisioned. The BgGPT key + gateway base URL/model + the
  // gateway id are read off the env (defaults below); VOICE_ASSISTANT_API_KEY falls back to ASSISTANT_API_KEY.
  const cfg = env as unknown as {
    ASSISTANT_API_KEY?: string;
    VOICE_ASSISTANT_API_KEY?: string;
    BGGPT_STT_BASE_URL?: string;
    BGGPT_STT_MODEL?: string;
    TRANSCRIBE_PRIMARY?: string;
    AI_GATEWAY_ID?: string;
  };
  const ai = env.AI as unknown as WhisperRunner | undefined;
  // `||` (not `??`): an empty-string VOICE key must fall through to ASSISTANT_API_KEY, not skip BgGPT.
  const bgKey = cfg.VOICE_ASSISTANT_API_KEY || cfg.ASSISTANT_API_KEY;
  if (!bgKey && !ai) {
    console.error('[transcribe] no STT provider — BgGPT key and AI binding both absent');
    return Response.json({ error: UNCONFIGURED }, { status: 503 });
  }

  // Account-wide BgGPT circuit-breaker (#135): the paid external STT leg honours the same global minute
  // budget as chat — the per-IP limiter can't stop a distributed denial-of-wallet. Consulted only when
  // BgGPT actually runs; when the breaker is open we degrade to the Workers AI fallback (on-platform,
  // separate budget — not gated here) and surface the 429/503 only if nothing else can serve.
  const isProd = import.meta.env.PROD;
  let breakerDenied: Response | null = null;

  // One attempt per provider — each guards its own config, catches + logs its own failure (so a fallback
  // is visible in telemetry), and returns null so the caller can try the next.
  const tryBgGpt = async (): Promise<Attempt | null> => {
    if (!bgKey || !cfg.BGGPT_STT_BASE_URL) return null;
    const denied = await rateLimitBgGptGlobal(request, env.BGGPT_CIRCUIT_BREAKER, isProd);
    if (denied) {
      breakerDenied = denied;
      return null;
    }
    try {
      const text = await transcribeViaBgGpt(
        cfg.BGGPT_STT_BASE_URL,
        bgKey,
        cfg.BGGPT_STT_MODEL ?? BGGPT_STT_MODEL,
        body.audio,
        body.mime,
      );
      return text.trim() ? { text, source: 'bggpt' } : null; // empty ⇒ failed attempt, let the fallback run
    } catch (err) {
      console.error('[transcribe] bggpt failed', err);
      return null;
    }
  };
  const tryWorkersAI = async (): Promise<Attempt | null> => {
    if (!ai) return null;
    try {
      const text = await transcribeViaWorkersAI(ai, body.audio, cfg.AI_GATEWAY_ID);
      return text.trim() ? { text, source: 'workers-ai' } : null;
    } catch (err) {
      console.error('[transcribe] workers-ai failed', err);
      return null;
    }
  };

  // BgGPT is primary unless TRANSCRIBE_PRIMARY flips it; the other is the automatic fallback. `??`
  // short-circuits — the fallback runs only if the primary returns null (unconfigured or failed).
  const [first, second] =
    cfg.TRANSCRIBE_PRIMARY === 'workers-ai' ? [tryWorkersAI, tryBgGpt] : [tryBgGpt, tryWorkersAI];
  const result = (await first()) ?? (await second());
  // Breaker-open with no successful fallback ⇒ surface its 429/503; otherwise the generic failure.
  if (!result) {
    return breakerDenied ?? Response.json({ error: TRANSCRIBE_FAILED }, { status: 503 });
  }

  // Metadata-only outcome log (no transcript, no audio) — recovers the fallback rate + provider mix that
  // the gateway would have shown. `bytes` is the base64 payload size, a cost/latency proxy.
  const primary: Provider = cfg.TRANSCRIBE_PRIMARY === 'workers-ai' ? 'workers-ai' : 'bggpt';
  console.log(
    JSON.stringify({
      evt: 'transcribe',
      source: result.source,
      fellBack: result.source !== primary,
      bytes: body.audio.length,
    }),
  );

  // Strip control/bidi chars + cap length before the text becomes an editable textarea value. `source`
  // records which provider served; `no-store` keeps transcript text uncached.
  return Response.json(
    { text: sanitizeTranscript(result.text), source: result.source },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
