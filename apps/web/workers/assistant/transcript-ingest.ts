// Ingest gate (ADR-0012 §1–2): filter the client-posted UIMessage history down to what is provably a
// current, authentic, in-order server emission for this conversation, before ANY of it reaches the
// model. `user` messages always pass (untrusted, never authoritative); forged/replayed/reordered/
// cross-conversation/unsigned `assistant` messages are dropped and telemetered (reason only — never
// content). Reuses transcript-hmac's `filterIncomingTranscript` for the crypto/slot logic and maps its
// kept tuples back to the original UIMessages by object identity, so the model sees the real messages,
// not re-serialized copies.

import type { UIMessage } from 'ai';
import {
  filterIncomingTranscript,
  type AssistantHmacEnv,
  type DropReason,
} from './transcript-hmac';
import { toTranscriptMessage } from './transcript-message';

export interface DroppedRecord {
  /** Role only — dropped content is never logged (it is attacker-controlled and may be sensitive). */
  role: string;
  reason: DropReason;
}

export interface IngestResult {
  kept: UIMessage[];
  dropped: DroppedRecord[];
}

/**
 * Drop every inbound `assistant`/`tool` UIMessage that is not an authentic, in-order, same-conversation
 * server emission; keep `user` messages verbatim. Throws if the signing key is unconfigured (fail
 * closed — the caller decides prod-refuse vs dev-skip, ADR-0012 §5). `conversationId` binds the kept
 * set to this thread; an empty/absent id drops all signed messages (secure default).
 */
export async function filterIncomingUIMessages(
  env: AssistantHmacEnv,
  messages: readonly UIMessage[],
  conversationId: string,
): Promise<IngestResult> {
  const byRef = new Map<object, UIMessage>();
  const tuples = [];
  for (const ui of messages) {
    const tuple = toTranscriptMessage(ui);
    // `null` = a role the scheme does not model (e.g. `system`). selectClientMessages already strips
    // these upstream; excluding them here is defense-in-depth, never surfaced to the model.
    if (!tuple) continue;
    byRef.set(tuple, ui);
    tuples.push(tuple);
  }

  const { kept, dropped } = await filterIncomingTranscript(env, tuples, conversationId);
  return {
    kept: kept.map((tuple) => byRef.get(tuple)!),
    dropped: dropped.map((d) => ({ role: d.message.role, reason: d.reason })),
  };
}
