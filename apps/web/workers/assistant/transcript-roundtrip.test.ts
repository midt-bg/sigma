// End-to-end symmetry: the REAL server signer (createTranscriptSigner) → a client message assembled with
// the ACTUAL AI SDK part shapes (state/toolCallId/input present, verified against ai's index.d.ts) → the
// REAL ingest gate (filterIncomingUIMessages). The signer's own unit test builds hand-made *partial* parts;
// this proves the extra SDK fields `messageReportRefs`/`messageContent` deliberately ignore don't perturb
// verification, and that a signer-produced signature survives the full ingest path — the make-or-break
// symmetry of ADR-0011, tested against production part shapes rather than a hand-rolled subset.

import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage, UIMessageChunk } from 'ai';
import { createTranscriptSigner, type EmitSlot } from './transcript-signer';
import { filterIncomingUIMessages } from './transcript-ingest';
import { resetKeyCache } from './transcript-hmac';
import type { SignedMeta } from './transcript-message';

const ENV = { ASSISTANT_HMAC_KEY: 'k'.repeat(48) };
const CONV = 'conv-e2e';

beforeEach(() => resetKeyCache());

// Push chunks through the real signer and return the message-metadata it appends.
async function sign(chunks: UIMessageChunk[], slot: EmitSlot): Promise<SignedMeta> {
  const src = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const out: unknown[] = [];
  const reader = src.pipeThrough(createTranscriptSigner(ENV, slot)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const metaChunk = out.find((c) => (c as { type?: string }).type === 'message-metadata');
  return (metaChunk as { messageMetadata: SignedMeta }).messageMetadata;
}

const user = (t: string): UIMessage =>
  ({ id: `u:${t}`, role: 'user', parts: [{ type: 'text', text: t }] }) as unknown as UIMessage;

// A client `tool-emit_report` part with the FULL shape the SDK stores (index.d.ts:1761 — state +
// input + output on an output-available tool part), NOT the partial {type,output} the unit test uses.
const sdkEmitReportPart = (output: unknown) => ({
  type: 'tool-emit_report',
  toolCallId: 'call_xyz',
  state: 'output-available',
  input: {},
  output,
});

// The client UIMessage useChat holds after a turn: assembled parts + the metadata the SDK merged in from
// the signer's message-metadata chunk (index.mjs updateMessageMetadata → state.message.metadata).
const clientAssistant = (parts: unknown[], meta: SignedMeta): UIMessage =>
  ({ id: `a:${meta.turnIndex}`, role: 'assistant', parts, metadata: meta }) as unknown as UIMessage;

describe('signer → SDK-shaped client message → ingest (production part shapes)', () => {
  it('keeps a faithful text + emit_report turn (extra SDK fields ignored by the signed tuple)', async () => {
    const output = { ok: true, report: { title: 'Разходи 2024' }, storedId: 'r_real' };
    const meta = await sign(
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Ето справката.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-start', toolCallId: 'call_xyz', toolName: 'emit_report' },
        {
          type: 'tool-input-available',
          toolCallId: 'call_xyz',
          toolName: 'emit_report',
          input: {},
        },
        { type: 'tool-output-available', toolCallId: 'call_xyz', output },
      ] as unknown as UIMessageChunk[],
      { conversationId: CONV, turnIndex: 0 },
    );

    const a = clientAssistant(
      [{ type: 'text', text: 'Ето справката.' }, sdkEmitReportPart(output)],
      meta,
    );
    const { kept, dropped } = await filterIncomingUIMessages(ENV, [user('питане'), a], CONV);

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBe(a); // identity preserved — the model sees the real message object
  });

  it('drops the turn when the report chip is re-pointed after signing (laundering, full part shape)', async () => {
    const output = { ok: true, report: { title: 'Разходи 2024' }, storedId: 'r_real' };
    const meta = await sign(
      [
        { type: 'tool-input-start', toolCallId: 'call_xyz', toolName: 'emit_report' },
        { type: 'tool-output-available', toolCallId: 'call_xyz', output },
      ] as unknown as UIMessageChunk[],
      { conversationId: CONV, turnIndex: 0 },
    );

    const evil = { ok: true, report: { title: 'Разходи 2024' }, storedId: 'r_ATTACKER' };
    const a = clientAssistant([sdkEmitReportPart(evil)], meta);
    const { kept, dropped } = await filterIncomingUIMessages(ENV, [a], CONV);

    expect(kept).toEqual([]);
    expect(dropped).toEqual([{ role: 'assistant', reason: 'invalid-signature' }]);
  });

  it('keeps a signed dedup cache-hit message (data-dedup chip, full round-trip)', async () => {
    const data = {
      reportId: 'r_cached',
      createdAt: '2026-01-01',
      layer: 'L1',
      label: 'Преизползван',
    };
    const meta = await sign([{ type: 'data-dedup', data }] as unknown as UIMessageChunk[], {
      conversationId: CONV,
      turnIndex: 0,
    });

    const a = clientAssistant([{ type: 'data-dedup', data }], meta);
    const { kept, dropped } = await filterIncomingUIMessages(ENV, [a], CONV);

    expect(dropped).toEqual([]);
    expect(kept).toEqual([a]);
  });

  it('carries a realistic two-turn thread through emit→ingest with signer-produced signatures', async () => {
    const meta0 = await sign(
      [
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', delta: 'Първи отговор' },
        { type: 'text-end', id: 'a' },
      ] as unknown as UIMessageChunk[],
      { conversationId: CONV, turnIndex: 0 },
    );
    const meta1 = await sign(
      [
        { type: 'text-start', id: 'b' },
        { type: 'text-delta', id: 'b', delta: 'Втори отговор' },
        { type: 'text-end', id: 'b' },
      ] as unknown as UIMessageChunk[],
      { conversationId: CONV, turnIndex: 1 },
    );

    const thread = [
      user('въпрос 1'),
      clientAssistant([{ type: 'text', text: 'Първи отговор' }], meta0),
      user('въпрос 2'),
      clientAssistant([{ type: 'text', text: 'Втори отговор' }], meta1),
    ];
    const { kept, dropped } = await filterIncomingUIMessages(ENV, thread, CONV);

    expect(dropped).toEqual([]);
    expect(kept).toEqual(thread);
  });

  it('drops a signed message replayed into a different conversation', async () => {
    const meta = await sign(
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'секретен извод' },
        { type: 'text-end', id: 't' },
      ] as unknown as UIMessageChunk[],
      { conversationId: CONV, turnIndex: 0 },
    );

    const a = clientAssistant([{ type: 'text', text: 'секретен извод' }], meta);
    const { kept, dropped } = await filterIncomingUIMessages(ENV, [a], 'OTHER-CONVERSATION');

    expect(kept).toEqual([]);
    expect(dropped).toEqual([{ role: 'assistant', reason: 'wrong-conversation' }]);
  });
});
