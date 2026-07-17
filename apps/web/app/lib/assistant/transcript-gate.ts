// §9.3 transcript gate (ADR-0011/0012): the single ordering-critical seam between authenticity and the
// model prompt. Two representations, in this order and no other:
//
//   1. VERIFY on the FULL client messages — every part intact. A server signature binds a message's
//      report chips (transcript-message.ts → messageReportRefs), so the text-strip below MUST NOT run
//      first: stripping the `tool-emit_report` / `data-dedup` parts before verification would make every
//      authentic report-bearing turn verify against `reports: []` and drop as tampered.
//   2. STRIP for the model — selectClientMessages reduces the *survivors* to text-only, role-filtered,
//      recency-capped messages, because convertToModelMessages (agent.ts) consumes text, not chips.
//
// Extracted from the route so this ordering can be unit-tested against genuinely signed fixtures without
// standing up the whole action.

import type { UIMessage } from 'ai';
import { selectClientMessages } from './chat-input';
import {
  filterIncomingUIMessages,
  type DroppedRecord,
} from '../../../workers/assistant/transcript-ingest';
import type { AssistantHmacEnv } from '../../../workers/assistant/transcript-hmac';

// This turn's server-message slot (ADR-0011): turnIndex is strictly greater than any authentic assistant
// turnIndex in the kept history, so signatures stay monotonic even across dropped/forged gaps.
export interface Signing {
  env: AssistantHmacEnv;
  conversationId: string;
  turnIndex: number;
}

export interface TranscriptGate {
  /** Model-ready view: authentic messages, text-only, role-filtered, recency-capped. */
  messages: UIMessage[];
  /** The emit slot for signing this turn's reply, or undefined when unsigned (no key). */
  signing: Signing | undefined;
  /** Dropped inauthentic messages — role + reason only, safe to telemeter (never content). */
  dropped: DroppedRecord[];
  /** True when a key is required (production) but unset — the caller must refuse (fail closed). */
  refuse: boolean;
}

// The next monotonic turn index: one past the highest authenticated assistant turnIndex. Derived from the
// full authenticated set (pre recency-slice) so a trimmed-away older turn can't let the counter regress.
function nextTurnIndex(messages: readonly UIMessage[]): number {
  let max = -1;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const t = (m.metadata as { turnIndex?: unknown } | undefined)?.turnIndex;
    if (typeof t === 'number' && Number.isInteger(t) && t > max) max = t;
  }
  return max + 1;
}

// Drop non-object array entries up front: toTranscriptMessage reads `.role` and would throw on a null
// element (untrusted JSON can contain them). String/number entries read as role-less → filtered anyway.
const isObjectMessage = (m: unknown): m is UIMessage => typeof m === 'object' && m !== null;

export async function gateTranscript(opts: {
  rawMessages: unknown;
  conversationId: string;
  /** Trimmed ASSISTANT_HMAC_KEY, or undefined/empty when the feature is unprovisioned. */
  hmacKey: string | undefined;
  /**
   * True on a stable public deploy (production/staging) where an unsigned transcript must never reach the
   * model — the caller derives it from the runtime `ENVIRONMENT` binding (never `import.meta.env.PROD`).
   * Ephemeral previews stay false (may run UI-only without the key); local dev is false.
   */
  requireKey: boolean;
  env: AssistantHmacEnv;
  maxMessages: number;
}): Promise<TranscriptGate> {
  const { rawMessages, conversationId, hmacKey, requireKey, env, maxMessages } = opts;
  const objects = Array.isArray(rawMessages) ? rawMessages.filter(isObjectMessage) : [];

  let authentic = objects;
  let dropped: DroppedRecord[] = [];
  if (hmacKey) {
    const result = await filterIncomingUIMessages(env, objects, conversationId);
    authentic = result.kept;
    dropped = result.dropped;
  } else if (requireKey) {
    // Stable public deploy without a key: refuse rather than run the model over an unverifiable transcript.
    return { messages: [], signing: undefined, dropped: [], refuse: true };
  }

  return {
    messages: selectClientMessages(authentic, maxMessages),
    signing: hmacKey ? { env, conversationId, turnIndex: nextTurnIndex(authentic) } : undefined,
    dropped,
    refuse: false,
  };
}
