# Voice input lane (`/assistant/transcribe`) — implementation record

Push-to-talk voice input for the СИГМА assistant dock: record a short clip → transcribe it to Bulgarian
text on the server → the text lands in the composer **editable, never auto-sent** → the user reviews/edits
and sends. This document records the full design and everything built, in order.

**Status:** implemented; branch `feat/assistant-voice-transcribe`. Tests green, typecheck clean. Launch-gate
items (Turnstile on voice, account-wide circuit-breaker) remain deferred (see §11).

---

## 1. Guiding principle — accessibility first

Voice is treated as an **accessibility feature**, not a convenience. For part of the audience (motor
disabilities, some literacy/cognitive profiles) it is the _only_ viable input, so every tradeoff sides with
the person who cannot fall back to the keyboard. The governing rule is **"never a dead mic":** at every
state there is a forward path that doesn't require an ability the state can't guarantee — and every failure
degrades to the always-usable text box.

## 2. Request flow (overview)

```
mic button (toggle) ─ click ─▶ getUserMedia (from the click handler — StrictMode-safe)
  │  MediaRecorder (native container: webm/opus | mp4/m4a) · ~60s cap + 50s warning
  │  live silence monitor (AudioContext/AnalyserNode) → auto-stop after 5s of quiet
  ▼ stop → FileReader base64 → POST application/json { audio, mime }   (JSON body = CSRF gate)
EDGE (workers/app.ts): rateLimitTranscribeRoute (per-IP 5/60, fail-closed) — before the handler
  ▼
routes/assistant.transcribe.tsx:
  kill switch → first-party guard → Turnstile → Content-Length pre-cap → measured byte cap (~3 MB)
  → parseTranscribeBody → mime allowlist → provisioning check
  → 700ms tap gate + post-hoc VAD (client) already filtered silence
  → provider chain (TRANSCRIBE_PRIMARY): tryBgGpt ?? tryWorkersAI   (empty text ⇒ failed ⇒ fallback)
  → sanitizeTranscript (strip control/bidi, cap length)
  → Response.json({ text, source }, { 'Cache-Control': 'no-store' }) + metadata-only telemetry
  ▼
transcript ─▶ composer append (editable; focus stays on mic; status announces "Готово…")
  ▼ user reviews/edits ─▶ Send ─▶ normal /assistant/chat text turn
```

Audio is transient — never written to R2/D1/KV/disk or the AI Gateway.

## 3. Backend — two Whisper providers

**The design evolved to BgGPT-primary + Workers-AI-fallback.** Initial thinking was Workers AI first; it was
reversed once we settled that BgGPT is free via the internal key and its trust boundary is already accepted
for chat (internal company — privacy is a non-issue here).

- **Primary — BgGPT/INSAIT Whisper.** `POST <base>/audio/transcriptions` (multipart: `file`, `model`,
  `language=bg`, `response_format=json`), model `bggpt-whisper-large-v3`, `Authorization: Bearer` with the
  server-side `ASSISTANT_API_KEY`. Base/model overridable via `BGGPT_STT_BASE_URL` / `BGGPT_STT_MODEL`
  (defaults `https://api.bggpt.ai/v1`, `bggpt-whisper-large-v3`).
- **Fallback — Cloudflare Workers AI Whisper.** `env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio,
language: 'bg' })`, called **directly with no AI Gateway** — the gateway logs request/response _payloads_
  by default (`collectLog` is all-or-nothing), so routing audio through it would persist voice in logs.
- **Order + observability.** `TRANSCRIBE_PRIMARY` env (`bggpt` default, or `workers-ai`) flips the order
  without a deploy. The two attempts are `?? `-chained; an **empty/mis-shaped** primary result is treated as
  a _failed_ attempt so the fallback engages (guards against a silent BgGPT shape change). The response
  carries `source` (`bggpt` | `workers-ai`), and a metadata-only line `{ evt, source, fellBack, bytes }` is
  logged (no transcript, no audio) so fallback rate + provider mix are observable without the gateway.
- **No browser (Web Speech) tier** — inconsistent across browsers and sends audio to Google. (This is what
  the reference project `kolkostruva` actually did; investigated and rejected.)
- **`language: 'bg'` forced** — Bulgarian-first audience; English-only utterances are an accepted edge case.

## 4. Server security & limits

- **CSRF / denial-of-wallet gate.** The clip is posted as `application/json` (client-side base64), so the
  JSON content-type _is_ the CSRF gate — a cross-site `fetch` forces a preflight that is never green-lit
  (reuses `firstPartyRejection` + `Sec-Fetch-Site`).
- **Rate limit.** New per-IP `TRANSCRIBE_RATE_LIMITER` (namespace 1006, 5/60), **fail-closed** in prod,
  wired at the edge in `workers/app.ts` **before** the handler; `.data`-suffix bypass closed by
  `normalizedPathname`.
- **Body cap.** `Content-Length` pre-cap then a **measured** byte cap of **~3 MB** before any inference.
  (History: briefly tightened to 1 MB as a DoW measure — that **rejected legitimate 60s clips**, because
  base64 inflates the audio ~1.33× and a 60s webm/opus clip's base64 body exceeds 1 MB → 413. Reverted to
  3 MB. Lesson: the byte cap bounds _size_, not _duration_; a cap tight enough to bound duration rejects
  real clips, so **duration-based DoW is the account-wide breaker's job**, not this cap — see §11.)
- **Mime allowlist** (`audio/webm|mp4|ogg`); **transcript sanitization** (`sanitizeTranscript` strips C0/C1
  controls, bidi overrides `U+202A–202E`, isolates `U+2066–2069`, LRM/RLM — Trojan-Source defense before the
  text becomes a textarea value then a chat message); `Cache-Control: no-store`.
- **Secret handling.** `ASSISTANT_API_KEY` is only ever the `Authorization` header to BgGPT — never in a
  response body, error message, `console.*`, or the telemetry line. Verified in review.
- **No SSRF.** The BgGPT URL is env-only; no request header/body reaches it.
- **Provisioning.** At least one provider (BgGPT key **or** `env.AI`) must be present, else 503
  „Гласовото въвеждане не е конфигурирано."
- **`Permissions-Policy: microphone=()` → `microphone=(self)`** (camera/geolocation stay denied), compensated
  by the strict CSP.

## 5. Client — the recording hook

`app/lib/assistant-dock/useVoiceInput.ts` — a discriminated-union state machine
(`idle | requesting | recording | transcribing | error`).

- **Permission from the click handler**, never an effect, so StrictMode's double-mount can't double-prompt.
- **Mount-safe:** a `mountedRef` is reset in the (only) effect and checked when `getUserMedia` resolves — if
  the dock unmounted while the permission prompt was open, the late stream is stopped instead of left live
  (fixes a real "mic stays on" leak).
- **Cleanup on every exit** (stop / error / unmount): mic tracks, cap + warning timers, the silence monitor
  - its AudioContext, and any in-flight fetch (AbortController). The OS mic indicator always clears.
- **20s fetch timeout** — a hung `/assistant/transcribe` transitions to an error state instead of pinning
  the mic in „Обработва се…" forever (a manual `timedOut` flag distinguishes timeout from unmount-abort).
- **`useElapsedSeconds.ts`** — the per-second `0:SS` timer ticks _locally in the mic component_, so recording
  re-renders only the mic, not the whole composer (React perf, rule 16.5). The hook itself exposes coarse
  `startedAt` + `endingSoon` (flips once at 50s for the "10 seconds left" status).

## 6. Silence & hallucination handling (three layers)

Whisper **invents text on silence** (it was trained only on segments that contain speech), so on a
speak-then-silence clip it pads the silent tail with fabrications (e.g. „… … …", „Абонирайте се!",
„Благодаря."). BgGPT gives us **no server-side lever** to suppress this — a probe confirmed it silently
_ignores_ `vad_filter`, `no_speech_threshold`, `condition_on_previous_text`, `compression_ratio_threshold`,
`temperature`, and `prompt` (all HTTP 200, identical hallucination), and returns `no_speech_prob: null`. So
the mitigation is client-side, in three layers:

1. **700 ms min-duration gate** — a sub-second clip is almost certainly an accidental tap; dropped before we
   spend a transcription call.
2. **Post-hoc VAD (`hasSpeech`)** — at stop, decode the clip and require the **max 20 ms-window RMS ≥ 0.015
   (≈ −36.5 dBFS)** — a value verified to sit between measured room noise (≤ −41 dBFS) and soft speech
   (≈ −32 dBFS). **Fail-open:** if Web Audio is missing or decode throws, treat as speech so a real user is
   never blocked (accessibility).
3. **Live auto-stop on silence** — during recording a headless `AudioContext`/`AnalyserNode` samples the mic
   level every 250 ms; once speech has been heard, **5 s of quiet auto-stops** the recording. This is the
   real fix for "spoke a sentence then walked away" — no long silent tail is recorded, so no hallucination,
   and the user doesn't wait out the 60 s cap. `ctx.resume()` guards against the autoplay policy starting
   the context suspended. Tunable via `SILENCE_STOP_MS` / `SPEECH_RMS_THRESHOLD`. Known limitation: in a
   _noisy_ room the level may never drop below threshold, so auto-stop won't fire and it falls back to the
   60 s cap (safe, not broken); a proper fix needs spectral/ML VAD, out of scope.

## 7. Composer wiring & clear button

`AssistantComposer.tsx` — the transcript **appends** to the draft via `appendTranscript` (exactly one
separator, no double space when the draft already ends in whitespace/newline), focus deliberately **stays on
the mic** so a screen reader isn't cut off, and the textarea is **never disabled** during mic states. A
single `canSend = !busy && trimmed !== ''` drives submit, Send, and the new **„Изчисти"** clear button
(one-tap wipe of the whole draft — easier than select-all-delete for motor/cognitive users after a
dictation they don't like). Voice status copy (`micStatusText`) and error copy (`VOICE_ERROR_COPY`) both live
in `errors.ts` (one home for voice copy).

## 8. Accessibility (WCAG 2.2 AA)

- Mic is a **toggle** (`aria-pressed`, state-changing accessible name „Гласово въвеждане" ⇄ „Спри записа"),
  centred square, ≥24 px target, `:focus-visible`; **tap-to-toggle** (no press-and-hold — motor-friendly).
- A composer-level **`role="status"` live region** announces each state (requesting / recording / 10s-left /
  processing / ready / errors); focus stays on the mic when a transcript lands so the announcement isn't cut.
- **Reduced motion:** the equalizer is **pure CSS** (no `AudioContext` for visuals), so the global
  `@media (prefers-reduced-motion)` rule freezes it — no rAF/canvas to miss.
- **Text-only mode P0 fix:** the dock used to be `display:none` in the a11y text-only mode, which locked
  voice away from the low-vision/cognitive users who rely on it most; now the launcher + desktop panel
  relinearise in-flow instead.
- Every failure ends at the textarea with clear Bulgarian copy — never a dead mic.

## 9. Files

| File                                                | Role                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `app/routes/assistant.transcribe.tsx`               | the endpoint (guards, provider chain, telemetry)                     |
| `app/lib/assistant/transcribe.ts`                   | pure helpers: `parseTranscribeBody`, `sanitizeTranscript`, mime/caps |
| `workers/transcribe-rate-limit.ts`                  | per-IP edge limiter (fail-closed)                                    |
| `app/lib/assistant-dock/useVoiceInput.ts`           | recording hook + VAD + auto-stop                                     |
| `app/lib/assistant-dock/useElapsedSeconds.ts`       | local timer tick (mic-scoped re-render)                              |
| `app/lib/assistant-dock/AssistantComposerMic.tsx`   | mic toggle + timer + CSS equalizer                                   |
| `app/lib/assistant-dock/AssistantComposer.tsx`      | wiring, append, clear button, status region                          |
| `app/lib/assistant-dock/errors.ts`                  | voice + chat copy, `micStatusText`, `classifyMediaError`             |
| `app/lib/security.ts`                               | `Permissions-Policy: microphone=(self)`                              |
| `workers/app.ts`, `app/routes.ts`, `wrangler.jsonc` | edge wiring, route registration, limiter binding                     |
| `docs/spec/ai-assistant.md` §6                      | the design spec (separate from this record)                          |

## 10. Testing

Vitest, env by file extension (`.test.ts` → node, `.test.tsx` → jsdom). Pure helpers, the hook (stubbed
`MediaRecorder`/`getUserMedia`/`AudioContext`/`fetch`, incl. mount-leak, min-duration gate, VAD, auto-stop,
timeout, error-clobber), the components, the route (provider order, empty→fallback, telemetry, every
rejection path asserts no provider called), and the limiter. Real-audio/codec/cross-browser and the
accessibility sweep (screen readers, keyboard, reduced-motion, text-only, target size) are manual — jsdom
has no MediaRecorder/Web Audio. `pnpm typecheck` clean.

## 11. Code review outcome

A strict security/quality review (secrets, SSRF, CSRF, sanitization, resource leaks, SSR safety, SRP/DRY,
CSS cascade, conventions) confirmed the security-critical surface clean (key never leaks, no SSRF, CSRF
solid, sanitization complete, no SQL/malicious code) and surfaced 12 findings — **11 fixed**: the mic leak,
the empty-text fallback-bypass, the hung-fetch timeout (+ removed dead `cancel`), the error clobber, the
tick re-render, the transcript double-space, `canSend` DRY, `micStatusText` SRP, the `TODO`/comment/test-loop
conventions, plus the auto-stop suspended-context bug. **PR review (#66)** added a capped streaming body
read (an upload-DoS: the old declared-Content-Length check buffered the whole body before the cap). **#8 —
the account-wide denial-of-wallet circuit-breaker** is now a **hard launch-gate item** in spec §8 (required
before `ASSISTANT_ENABLED=true`), not a deferred code comment — the paid path bypasses the gateway, so the
per-IP cap alone can't stop a distributed DoW.

## 12. Deferred

- Turnstile on voice + account-wide circuit-breaker (launch gate — the real DoW control).
- English auto-detect; push-to-talk _preference_ (tap-to-toggle stays default).
- In-browser WASM Whisper (max privacy) / spectral-or-ML VAD (robust silence detection in noisy rooms).
