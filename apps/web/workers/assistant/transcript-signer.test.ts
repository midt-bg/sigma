import { describe, expect, it, beforeEach } from 'vitest';
import type { UIMessage, UIMessageChunk } from 'ai';
import { createTranscriptSigner, type EmitSlot } from './transcript-signer';
import { resetKeyCache, verifyMessage } from './transcript-hmac';
import { toTranscriptMessage, type SignedMeta } from './transcript-message';

const ENV = { ASSISTANT_HMAC_KEY: 'k'.repeat(48) };
const SLOT: EmitSlot = { conversationId: 'conv-1', turnIndex: 2 };

beforeEach(() => resetKeyCache());

// Run a chunk sequence through the signer and return the appended message-metadata.
async function sign(chunks: unknown[]): Promise<{ out: unknown[]; meta: SignedMeta }> {
  const src = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch as UIMessageChunk);
      c.close();
    },
  });
  const out: unknown[] = [];
  const reader = src.pipeThrough(createTranscriptSigner(ENV, SLOT)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const metaChunk = out.find((c) => (c as { type?: string }).type === 'message-metadata');
  return { out, meta: (metaChunk as { messageMetadata: SignedMeta }).messageMetadata };
}

// The CLIENT assembles a message independently of the signer; build the expected client message by hand
// (explicit parts) and attach the emitted metadata, then verify. If the signer's internal reconstruction
// diverges from this hand-built truth, verification fails — that is the symmetry guarantee under test.
function clientMessage(parts: unknown[], meta: SignedMeta): UIMessage {
  return { id: 'c', role: 'assistant', parts, metadata: meta } as unknown as UIMessage;
}
const verifies = (parts: unknown[], meta: SignedMeta) =>
  verifyMessage(ENV, toTranscriptMessage(clientMessage(parts, meta))!);

describe('createTranscriptSigner — sig verifies against the client-assembled message', () => {
  it('appends exactly one message-metadata chunk carrying the slot', async () => {
    const { out, meta } = await sign([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Здравей' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(out.filter((c) => (c as { type?: string }).type === 'message-metadata')).toHaveLength(1);
    expect(meta).toMatchObject({ conversationId: 'conv-1', turnIndex: 2, position: 0 });
    expect(meta.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a single text part', async () => {
    const { meta } = await sign([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Общо: ' },
      { type: 'text-delta', id: 't1', delta: '100 лв.' },
      { type: 'text-end', id: 't1' },
    ]);
    await expect(verifies([{ type: 'text', text: 'Общо: 100 лв.' }], meta)).resolves.toBe(true);
  });

  it('text + a persisted emit_report chip (id + title bound)', async () => {
    const output = { ok: true, report: { title: 'Разход 2024' }, storedId: 'r_abc' };
    const { meta } = await sign([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Ето справката.' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'emit_report' },
      { type: 'tool-output-available', toolCallId: 'c1', output },
    ]);
    const parts = [
      { type: 'text', text: 'Ето справката.' },
      { type: 'tool-emit_report', output },
    ];
    await expect(verifies(parts, meta)).resolves.toBe(true);
  });

  it('two separate text parts joined by newline', async () => {
    const { meta } = await sign([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'Първи' },
      { type: 'text-end', id: 'a' },
      { type: 'text-start', id: 'b' },
      { type: 'text-delta', id: 'b', delta: 'Втори' },
      { type: 'text-end', id: 'b' },
    ]);
    const parts = [
      { type: 'text', text: 'Първи' },
      { type: 'text', text: 'Втори' },
    ];
    await expect(verifies(parts, meta)).resolves.toBe(true);
  });

  it('a data-dedup reuse part (chip bound, no prose)', async () => {
    const data = { reportId: 'r_z', label: 'Преизползван отчет' };
    const { meta } = await sign([{ type: 'data-dedup', data }]);
    await expect(verifies([{ type: 'data-dedup', data }], meta)).resolves.toBe(true);
  });

  it('rejects when the client text is tampered after signing', async () => {
    const { meta } = await sign([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Общо: 100 лв.' },
      { type: 'text-end', id: 't1' },
    ]);
    await expect(verifies([{ type: 'text', text: 'Общо: 999 999 лв.' }], meta)).resolves.toBe(
      false,
    );
  });

  it('rejects when the report chip is re-pointed after signing (laundering)', async () => {
    const output = { ok: true, report: { title: 'Разход 2024' }, storedId: 'r_abc' };
    const { meta } = await sign([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'emit_report' },
      { type: 'tool-output-available', toolCallId: 'c1', output },
    ]);
    const evil = { ok: true, report: { title: 'Разход 2024' }, storedId: 'r_EVIL' };
    await expect(verifies([{ type: 'tool-emit_report', output: evil }], meta)).resolves.toBe(false);
  });
});
