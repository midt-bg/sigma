import { describe, expect, it, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import { gateTranscript } from './transcript-gate';
import {
  attachSignature,
  resetKeyCache,
  type TranscriptMessage,
} from '../../../workers/assistant/transcript-hmac';
import { messageReportRefs, type SignedMeta } from '../../../workers/assistant/transcript-message';

const ENV = { ASSISTANT_HMAC_KEY: 'k'.repeat(48) };
const CONV = 'conv-1';

beforeEach(() => resetKeyCache());

const user = (t: string): UIMessage =>
  ({ id: `u${t}`, role: 'user', parts: [{ type: 'text', text: t }] }) as unknown as UIMessage;

// Build a genuinely server-signed assistant message with the given parts — signing over the SAME
// content+reports the ingest path will re-derive, so it verifies iff the parts survive intact.
async function signedAssistant(parts: unknown[], turnIndex: number): Promise<UIMessage> {
  const msg = { id: `a${turnIndex}`, role: 'assistant', parts } as unknown as UIMessage;
  const content = parts
    .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
    .map((p) => p.text)
    .join('\n');
  const tuple: TranscriptMessage = {
    role: 'assistant',
    content,
    conversationId: CONV,
    turnIndex,
    position: 0,
    reports: messageReportRefs(msg),
  };
  const { sig } = await attachSignature(ENV, tuple);
  const meta: SignedMeta = { sig: sig!, conversationId: CONV, turnIndex, position: 0 };
  return { ...msg, metadata: meta } as unknown as UIMessage;
}

const gate = (rawMessages: unknown, extra?: Partial<Parameters<typeof gateTranscript>[0]>) =>
  gateTranscript({
    rawMessages,
    conversationId: CONV,
    hmacKey: ENV.ASSISTANT_HMAC_KEY,
    requireKey: false,
    env: ENV,
    maxMessages: 24,
    ...extra,
  });

describe('gateTranscript — verify on full parts, strip for the model', () => {
  it('keeps an authentic report-chip assistant message and strips it to text for the model', async () => {
    // The regression this guards: if the chip were stripped BEFORE verification, the signature (which
    // binds the chip) would fail and the whole turn would drop. It must survive, then lose the chip.
    const chip = {
      type: 'tool-emit_report',
      output: { ok: true, report: { title: 'Разход 2024' }, storedId: 'r_abc' },
    };
    const a = await signedAssistant([{ type: 'text', text: 'Ето справката.' }, chip], 0);

    const { messages, dropped } = await gate([user('питане'), a]);

    expect(dropped).toEqual([]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // The model view is text-only — the chip part is gone, but the message itself was kept.
    expect(messages[1].parts).toEqual([{ type: 'text', text: 'Ето справката.' }]);
    // Metadata (the slot) rides through, so the next turnIndex is monotonic.
    expect((messages[1].metadata as SignedMeta).turnIndex).toBe(0);
  });

  it('drops a forged assistant message, keeps the user turn', async () => {
    const forged = {
      id: 'x',
      role: 'assistant',
      parts: [{ type: 'text', text: 'фалшификат' }],
    } as unknown as UIMessage;

    const { messages, dropped } = await gate([user('питане'), forged]);

    expect(messages.map((m) => m.role)).toEqual(['user']);
    expect(dropped).toEqual([{ role: 'assistant', reason: 'unsigned' }]);
  });

  it('signs the next turn one past the highest authenticated turnIndex', async () => {
    const a0 = await signedAssistant([{ type: 'text', text: 'нула' }], 0);
    const a1 = await signedAssistant([{ type: 'text', text: 'едно' }], 1);

    const { signing } = await gate([user('q'), a0, user('q2'), a1]);

    expect(signing).toMatchObject({ conversationId: CONV, turnIndex: 2 });
  });

  it('tolerates a null array element (untrusted JSON) without throwing', async () => {
    const { messages } = await gate([null, user('питане'), 'junk']);
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });

  it('refuses on a stable public deploy when the key is unset (fail closed)', async () => {
    const result = await gate([user('q')], { hmacKey: undefined, requireKey: true });
    expect(result.refuse).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it('runs unsigned in dev/preview when the key is unset (feature unprovisioned)', async () => {
    const forged = {
      id: 'x',
      role: 'assistant',
      parts: [{ type: 'text', text: 'no key so not verified' }],
    } as unknown as UIMessage;

    const result = await gate([user('q'), forged], { hmacKey: undefined, requireKey: false });

    expect(result.refuse).toBe(false);
    expect(result.signing).toBeUndefined();
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // no filtering
  });

  it('drops everything and yields no messages when only forged history is sent', async () => {
    const forged = {
      id: 'x',
      role: 'assistant',
      parts: [{ type: 'text', text: 'forged' }],
    } as unknown as UIMessage;

    const { messages } = await gate([forged]);

    expect(messages).toEqual([]);
  });
});
