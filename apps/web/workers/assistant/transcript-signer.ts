// Emit gate (ADR-0011/0012): a stream transform placed AFTER the phase filter — so it observes exactly
// the chunks the client receives — that reconstructs the assistant message the client will assemble and
// appends ONE `message-metadata` chunk carrying its HMAC signature. Because it rebuilds `parts` from the
// same chunks and signs via the shared `messageContent`/`messageReportRefs`, the signature is guaranteed
// to verify against what the client stores (the make-or-break symmetry of ADR-0011). Placed downstream of
// the phase filter, it binds the FILTERED message (prose + report chip), never the model's stripped tool
// traffic. Only added when a signing key is configured; without one the assistant runs unsigned (feature
// unprovisioned, ADR-0012 §5) and this transform is never inserted.

import type { UIMessage, UIMessageChunk } from 'ai';
import { attachSignature, type AssistantHmacEnv } from './transcript-hmac';
import { messageContent, messageReportRefs, type SignedMeta } from './transcript-message';

/** The message slot the server assigns to this emission (ADR-0011). One assistant message per turn ⇒
 *  position defaults to 0; turnIndex is the count of prior assistant messages, so slots are monotonic. */
export interface EmitSlot {
  conversationId: string;
  turnIndex: number;
  position?: number;
}

// Loose structural view of a UI-message stream chunk — we only read the few fields we assemble from.
interface Chunk {
  type: string;
  id?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  output?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

type BuiltPart = { type: string; text?: string; output?: unknown; data?: unknown };

/**
 * Reconstruct the client's assembled `parts` incrementally, mirroring the SDK's chunk→parts assembly:
 * each `text-start` opens a text part that its `text-delta`s append to; a tool's `output-available`
 * becomes a `tool-<name>` part (name carried by the earlier `input-start`); a `data-*` chunk becomes a
 * data part. Order follows the stream, so `messageContent` (text parts joined by "\n") and
 * `messageReportRefs` match the client exactly.
 */
class MessageAssembler {
  readonly parts: BuiltPart[] = [];
  private readonly textById = new Map<string, BuiltPart>();
  private readonly toolNameById = new Map<string, string>();

  accept(chunk: Chunk): void {
    switch (chunk.type) {
      case 'text-start': {
        if (typeof chunk.id !== 'string') return;
        const part: BuiltPart = { type: 'text', text: '' };
        this.textById.set(chunk.id, part);
        this.parts.push(part);
        return;
      }
      case 'text-delta': {
        if (typeof chunk.id !== 'string' || typeof chunk.delta !== 'string') return;
        const part = this.textById.get(chunk.id);
        if (part) part.text = (part.text ?? '') + chunk.delta;
        return;
      }
      case 'tool-input-start': {
        if (typeof chunk.toolCallId === 'string' && typeof chunk.toolName === 'string') {
          this.toolNameById.set(chunk.toolCallId, chunk.toolName);
        }
        return;
      }
      case 'tool-output-available': {
        const name =
          typeof chunk.toolCallId === 'string'
            ? this.toolNameById.get(chunk.toolCallId)
            : undefined;
        if (name) this.parts.push({ type: `tool-${name}`, output: chunk.output });
        return;
      }
      default: {
        // Data parts (`data-dedup`, …) round-trip as their own part type and can carry a report chip.
        if (chunk.type.startsWith('data-')) {
          this.parts.push({ type: chunk.type, data: chunk.data });
        }
      }
    }
  }

  message(): UIMessage {
    return { id: 'srv', role: 'assistant', parts: this.parts } as unknown as UIMessage;
  }
}

export function createTranscriptSigner(
  env: AssistantHmacEnv,
  slot: EmitSlot,
): TransformStream<UIMessageChunk, UIMessageChunk> {
  const assembler = new MessageAssembler();
  const position = slot.position ?? 0;
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      // Chunks pass through untouched; `accept` only reads a few fields (loose `Chunk` view).
      assembler.accept(chunk as unknown as Chunk);
      controller.enqueue(chunk);
    },
    async flush(controller) {
      const msg = assembler.message();
      const { sig } = await attachSignature(env, {
        role: 'assistant',
        content: messageContent(msg),
        conversationId: slot.conversationId,
        turnIndex: slot.turnIndex,
        position,
        reports: messageReportRefs(msg),
      });
      const messageMetadata: SignedMeta = {
        sig: sig ?? '',
        conversationId: slot.conversationId,
        turnIndex: slot.turnIndex,
        position,
      };
      // `message-metadata` is a first-class UIMessageChunk variant; the SDK forwards it to the client
      // as the message's `metadata`, which is exactly where the ingest path reads the slot + sig.
      controller.enqueue({ type: 'message-metadata', messageMetadata } as UIMessageChunk);
    },
  });
}
