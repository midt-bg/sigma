// Contract test — the make-or-break invariant of ADR-0011 against the REAL SDK assembler.
//
// The signer (createTranscriptSigner) reconstructs the client's `parts` from stream chunks and signs the
// derived content+reports. Correctness rests on that reconstruction matching how the browser's SDK
// actually assembles the same chunks. transcript-signer.test / transcript-roundtrip.test build the client
// message BY HAND — which encodes our *assumption* of SDK behaviour. This test instead runs the identical
// chunk stream through the installed SDK's own `readUIMessageStream`, then verifies the signer's signature
// against the SDK-assembled message. If a future `ai` bump changes assembly (coalesces text parts, adds a
// part, reorders) so the signer diverges, this FAILS IN CI — instead of silently dropping the entire
// assistant history in production (the failure mode is a bare console.warn). `ai` is pinned exact so this
// stays a genuine tripwire on deliberate upgrades.

import { describe, it, expect, beforeEach } from 'vitest';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { createTranscriptSigner, type EmitSlot } from './transcript-signer';
import { resetKeyCache, verifyMessage } from './transcript-hmac';
import { toTranscriptMessage, type SignedMeta } from './transcript-message';

const ENV = { ASSISTANT_HMAC_KEY: 'k'.repeat(48) };
const SLOT: EmitSlot = { conversationId: 'conv-sdk', turnIndex: 0 };

beforeEach(() => resetKeyCache());

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

// Sign the chunk stream with the real signer → the SignedMeta it appends.
async function sign(chunks: UIMessageChunk[]): Promise<SignedMeta> {
  const out: unknown[] = [];
  const reader = streamOf(chunks).pipeThrough(createTranscriptSigner(ENV, SLOT)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const metaChunk = out.find((c) => (c as { type?: string }).type === 'message-metadata');
  return (metaChunk as { messageMetadata: SignedMeta }).messageMetadata;
}

// Assemble the message the way the browser does — via the installed SDK, not by hand.
async function sdkAssemble(chunks: UIMessageChunk[]): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream: streamOf(chunks) })) last = m;
  if (!last) throw new Error('SDK assembled no message');
  return last;
}

// The signature verifies against the SDK-assembled message iff the signer's content+reports match the
// SDK's — the symmetry guarantee, tested end to end against real SDK output.
async function symmetric(chunks: UIMessageChunk[]): Promise<boolean> {
  const meta = await sign(chunks);
  const msg = await sdkAssemble(chunks);
  (msg as { metadata?: unknown }).metadata = meta;
  return verifyMessage(ENV, toTranscriptMessage(msg)!);
}

// Server streams are framed with start/finish; include them so the SDK assembles exactly as in prod. The
// signer ignores framing chunks (only text/tool/data feed content+reports), so both sides stay in step.
const framed = (...parts: UIMessageChunk[]): UIMessageChunk[] =>
  [{ type: 'start' }, ...parts, { type: 'finish' }] as unknown as UIMessageChunk[];

describe('signer ↔ real SDK assembler symmetry (ai pinned exact)', () => {
  it('single text message', async () => {
    await expect(
      symmetric(
        framed(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Общо: ' },
          { type: 'text-delta', id: 't1', delta: '100 лв.' },
          { type: 'text-end', id: 't1' },
        ),
      ),
    ).resolves.toBe(true);
  });

  it('two separate text parts (join must match the SDK)', async () => {
    await expect(
      symmetric(
        framed(
          { type: 'text-start', id: 'a' },
          { type: 'text-delta', id: 'a', delta: 'Първи' },
          { type: 'text-end', id: 'a' },
          { type: 'text-start', id: 'b' },
          { type: 'text-delta', id: 'b', delta: 'Втори' },
          { type: 'text-end', id: 'b' },
        ),
      ),
    ).resolves.toBe(true);
  });

  it('text + emit_report chip (storedId + title bound)', async () => {
    const output = { ok: true, report: { title: 'Разходи 2024' }, storedId: 'r_abc' };
    await expect(
      symmetric(
        framed(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Ето справката.' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'emit_report' },
          { type: 'tool-input-available', toolCallId: 'c1', toolName: 'emit_report', input: {} },
          { type: 'tool-output-available', toolCallId: 'c1', output },
        ),
      ),
    ).resolves.toBe(true);
  });

  it('data-dedup reuse chip', async () => {
    const data = { reportId: 'r_z', createdAt: '2026-01-01', layer: 'L1', label: 'Преизползван' };
    await expect(symmetric(framed({ type: 'data-dedup', data }))).resolves.toBe(true);
  });

  it('data-report-ready chip (now bound by the signature)', async () => {
    const data = { reportId: 'r_ready', title: 'Готов отчет' };
    await expect(symmetric(framed({ type: 'data-report-ready', data }))).resolves.toBe(true);
  });
});
