# Implementation Plan: feat/assistant-stream-phases — phases-only assistant streaming

## Executive Summary

- **Goal:** Only coarse turn phases reach the dock, never the raw agent stream (`run_sql` SQL
  assembly + raw D1 rows are dropped server-side); every phase change is surfaced to the visitor.
- **Phases (closed enum, wire carries the key only):** `thinking` → „Обмислям…", `querying` →
  „Търся в данните…", `composing` → „Съставям справка…". Ephemeral line — clears when the turn
  settles.
- **Complexity:** Medium · ~8 files touched, 3 new · **Risk:** Medium (touches the live stream
  contract), mitigated by a strict allowlist filter + exact-sequence tests.
- **Base:** `feat/ai-assistant-contracts`. SDK surfaces verified against the installed
  `ai@6.0.208` / `@ai-sdk/react@3.0.210` (not docs).

## Problem

`agent.ts` returns `result.toUIMessageStreamResponse()` — the raw SDK UI-message stream. That
serializes the whole tool loop to the browser: `tool-input-delta` chunks carry the SQL query
being assembled token-by-token, `tool-output-available` carries the raw D1 rows. The dock renders
none of it but `storage.ts` persists whole messages to localStorage and re-POSTs them as history.
Meanwhile the only progress affordances are a generic spinner and a per-message „Подготвям
справка…" line.

## Design

### Server

- **`apps/web/app/lib/assistant/stream-phase.ts` (new)** — `createPhaseFilter()`: a
  `TransformStream<UIMessageChunk, UIMessageChunk>` between `toUIMessageStream()` and the
  Response. **Strict allowlist** (fail-closed, survives SDK upgrades):
  - KEEP: `text-*`, `start`/`finish`/`start-step`/`finish-step`/`abort`, `error` (masked
    upstream by `onError`), `data-phase` (self-emitted) + `data-report-ready`, and `tool-*`
    chunks attributed to `emit_report` (including `tool-output-error`, so a failed report
    settles).
  - DROP: everything else — all other `tool-*`, `reasoning-*`, `source-*`, `file`,
    `message-metadata`, unknown/future chunk types, unattributed tool chunks.
  - `toolCallId → toolName` map built from the name-bearing chunks
    (`tool-input-start/available/error`) — mandatory, because output-side chunks carry only
    `toolCallId`.
  - Phase emission (deduped on last-emitted): `thinking` on `start`, `querying` on any
    non-emit_report tool chunk, `composing` on emit_report chunks. Regression
    (`composing` → `querying`) allowed — the model may run more SQL after a failed emit.
  - Phase chunks are `transient: true` — delivered to `useChat`'s `onData`, never added to
    `message.parts` (verified in SDK source), so nothing new is persisted or re-POSTed.
  - **Redaction:** an emit_report `tool-output-available` with `output.ok === false` is
    forwarded with `errors: []` — the schema-echoing validation strings stay model-side (the
    model reads the tool result inside `streamText`, not this projection); the dock renders its
    generic failure line either way.
  - **Never throws:** guarded field access; a malformed chunk is dropped (a throw downstream of
    `onError` would bypass the Bulgarian error masking).
- **`agent.ts`** — swap `toUIMessageStreamResponse({onError})` for
  `toUIMessageStream({ onError, sendReasoning: false, sendSources: false })
  .pipeThrough(createPhaseFilter())` wrapped in `createUIMessageStreamResponse({ stream })`.
- **`system-prompt.ts`** — internals non-disclosure rule (defense-in-depth for the prose
  channel the filter cannot close: the model narrating SQL in text). Overlaps fork PR #20's
  `NO_INTERNAL_FIELDS_RULE` (report blocks); if that merges first, fold into one rule.

### Contract

- **`assistant-contract/stream.ts`** — `ASSISTANT_PHASES` (closed enum), `PHASE_PART =
  'data-phase'`, `PhaseData`/`PhasePart`, `isPhasePart()` **validating the enum** (stricter than
  the file's type-tag-only convention — deliberate: the key drives a client label lookup).
- **No change to `fixtures/chat-stream.sample.json`** — it is a persisted-messages fixture and
  transient phases never persist.
- `docs/spec/assistant-contracts.md` §3 — document the filtered wire + the transient
  `data-phase` part; changelog v2.

### Client

- **`useAssistantChat.ts`** — `onData: (part) => { if (isPhasePart(part)) setPhase(part.data.phase) }`;
  phase cleared on status `'submitted'` (stale-flash guard) / `'ready'` / `'error'`; returns
  `{ ...chat, phase }` with an explicit return-type annotation (declaration-emit safety).
- **`AssistantPhaseLine.tsx` (new)** — presentational; maps the enum key to the fixed Bulgarian
  label client-side; unknown key or `null` renders nothing.
- **`AssistantTranscript.tsx`** — renders the phase line **inside** the existing
  `role="log"`/`aria-live="polite"` scroll region (single live region — announced, scrolls with
  the log). The per-message „Подготвям справка…" pending line is **removed** (decision
  2026-07-02: the global `composing` phase owns that affordance) — `isReportPending` and its
  tests are deleted as dead code.
- **`AssistantPanel.tsx` / `AssistantDock.tsx`** — thread `phase` down (optional prop; existing
  tests unaffected).
- **`app.css`** — `.assistant-transcript__pending` renamed `.assistant-transcript__phase`.

## Testing (tests written with the code)

- `stream-phase.test.ts` (node): exact-sequence `toEqual` assertions driving scripted
  `UIMessageChunk` arrays through the filter — run_sql cycle collapsed to one `querying`; dedup;
  emit_report cycle intact + `composing`; `{ok:false}` redaction; unattributed drop (fail
  closed); reasoning/source/file/metadata/unknown-data drops; `data-report-ready` passthrough;
  malformed chunk no-throw; `composing`→`querying` regression; structural markers pass; full
  realistic turn. Builders use **raw chunk shapes** (`tool-input-start` + `toolName`), never the
  persisted `tool-<name>` part shape — different layers.
- `stream.test.ts` (contract): `isPhasePart` accepts each valid phase; rejects wrong tag,
  missing data, unknown/non-string phase.
- `useAssistantChat.phase.test.tsx` (dom): mock upgraded to capture the `useChat` options object
  (the existing mock ignores it); phase set via `onData`, non-phase/malformed parts ignored,
  cleared on `ready` and on `submitted`.
- `AssistantPhaseLine.test.tsx` (dom): each key → exact label; null → nothing.
- `AssistantTranscript.test.tsx`: pending-line test replaced by phase-line tests asserting the
  label renders **within** `getByRole('log')`.
- `system-prompt.test.ts`: the non-disclosure rule is present in every prompt.

## Accepted residuals (documented, not built)

- Model **prose** can still narrate SQL — covered only by the prompt rule (soft control); a
  deterministic outgoing-text scan is a possible follow-up.
- `emit_report` **output** legitimately carries the bound report data (same payload as public
  `/reports/:id`); the guarantee is "no SQL, no un-selected columns", not "no data".
- Legacy localStorage transcripts hold old tool parts (self-exposure only; the server already
  strips them from re-POSTs via `selectClientMessages`). Optional schema-version purge deferred.
- `querying` stays up during post-tool prose until the next phase — accepted for v1 (the
  streaming text itself is visible).
- `fixtures/sse-stream.fixture.txt` shows the pre-filter wire; kept as historical reference,
  noted in the contracts doc.

## Verification

`pnpm --filter @sigma/web test` + `tsc -b` + `prettier --check` green; manual dev run: phases
appear/clear per turn, report chip unaffected, DevTools Network shows no `run_sql` chunks, no
spurious render for tool-only steps.

## Multi-Agent Review

Reviewed 2026-07-02 by three parallel agents (architecture / security / testing):
3× APPROVE-WITH-CHANGES, all required changes folded into this plan (strict allowlist,
never-throw, fixture non-change, phase line inside the log region, `{ok:false}` redaction,
clear-on-submitted, mock upgrade, exact-sequence tests). Validated by the main agent against
installed SDK sources: PASSED.

---

**Status:** Approved · **Created:** 2026-07-02 · **Approved by:** nmilenkov (pending-line
removal + doc location confirmed 2026-07-02)
