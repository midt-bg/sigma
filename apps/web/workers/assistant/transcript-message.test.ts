import { describe, expect, it, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import {
  messageContent,
  messageReportRefs,
  readSignedMeta,
  toTranscriptMessage,
  type SignedMeta,
} from './transcript-message';
import {
  attachSignature,
  resetKeyCache,
  verifyMessage,
  type TranscriptMessage,
} from './transcript-hmac';

const ENV = { ASSISTANT_HMAC_KEY: 'k'.repeat(48) };

beforeEach(() => resetKeyCache());

const text = (t: string) => ({ type: 'text', text: t }) as const;
const msg = (
  role: 'user' | 'assistant' | 'system',
  parts: unknown[],
  metadata?: unknown,
): UIMessage =>
  ({ id: 'm', role, parts, ...(metadata ? { metadata } : {}) }) as unknown as UIMessage;

describe('messageContent', () => {
  it('joins text parts with newline, ignoring non-text parts', () => {
    const m = msg('assistant', [
      text('Ред 1'),
      { type: 'tool-emit_report', output: { ok: true, report: { title: 'X' }, storedId: 'r_1' } },
      text('Ред 2'),
    ]);
    expect(messageContent(m)).toBe('Ред 1\nРед 2');
  });

  it('is empty for a message with no text parts', () => {
    expect(messageContent(msg('assistant', [{ type: 'step-start' }]))).toBe('');
  });
});

describe('messageReportRefs', () => {
  it('extracts a persisted emit_report chip (storedId + report title), in order', () => {
    const m = msg('assistant', [
      text('Готово'),
      {
        type: 'tool-emit_report',
        output: { ok: true, report: { title: 'Разход 2024' }, storedId: 'r_abc' },
      },
    ]);
    expect(messageReportRefs(m)).toEqual([{ id: 'r_abc', title: 'Разход 2024' }]);
  });

  it('extracts a data-dedup reuse chip (reportId + label)', () => {
    const m = msg('assistant', [
      { type: 'data-dedup', data: { reportId: 'r_z', label: 'Преизползван' } },
    ]);
    expect(messageReportRefs(m)).toEqual([{ id: 'r_z', title: 'Преизползван' }]);
  });

  it('extracts a data-report-ready chip (reportId + title)', () => {
    const m = msg('assistant', [
      { type: 'data-report-ready', data: { reportId: 'r_ready', title: 'Готов отчет' } },
    ]);
    expect(messageReportRefs(m)).toEqual([{ id: 'r_ready', title: 'Готов отчет' }]);
  });

  it('omits a data-report-ready chip missing reportId or title', () => {
    const noId = msg('assistant', [{ type: 'data-report-ready', data: { title: 'Готов' } }]);
    const noTitle = msg('assistant', [{ type: 'data-report-ready', data: { reportId: 'r_x' } }]);
    expect(messageReportRefs(noId)).toEqual([]);
    expect(messageReportRefs(noTitle)).toEqual([]);
  });

  it('omits an emit_report that did not persist (no storedId) or failed', () => {
    const noId = msg('assistant', [
      { type: 'tool-emit_report', output: { ok: true, report: { title: 'X' } } },
    ]);
    const failed = msg('assistant', [
      { type: 'tool-emit_report', output: { ok: false, errors: ['bad'] } },
    ]);
    expect(messageReportRefs(noId)).toEqual([]);
    expect(messageReportRefs(failed)).toEqual([]);
  });
});

describe('readSignedMeta', () => {
  const good: SignedMeta = { sig: 'ab12', conversationId: 'c1', turnIndex: 2, position: 0 };

  it('reads a well-formed metadata object', () => {
    expect(readSignedMeta(msg('assistant', [], good))).toEqual(good);
  });

  it('rejects partial / wrong-typed / negative-slot metadata as null', () => {
    for (const bad of [
      undefined,
      null,
      { sig: 'x', conversationId: 'c', turnIndex: 0 }, // missing position
      { sig: 'x', conversationId: 'c', turnIndex: -1, position: 0 }, // negative slot
      { sig: 'x', conversationId: 'c', turnIndex: 1.5, position: 0 }, // non-integer
      { sig: 5, conversationId: 'c', turnIndex: 0, position: 0 }, // sig not string
    ]) {
      expect(readSignedMeta(msg('assistant', [], bad))).toBeNull();
    }
  });
});

describe('toTranscriptMessage', () => {
  it('keeps a user message unsigned (no sig, role user)', () => {
    const t = toTranscriptMessage(msg('user', [text('питане')]));
    expect(t).toMatchObject({ role: 'user', content: 'питане' });
    expect(t?.sig).toBeUndefined();
  });

  it('returns null for an unmodelled role (system)', () => {
    expect(toTranscriptMessage(msg('system', [text('sys')]))).toBeNull();
  });

  it('an assistant message without metadata is slot-less and sig-less (→ dropped as unsigned)', () => {
    const t = toTranscriptMessage(msg('assistant', [text('фалшив ход')]));
    expect(t?.sig).toBeUndefined();
  });
});

// The make-or-break invariant: a message the emit path signed must verify after round-tripping through
// the client, and any edit to its visible text must fail verification.
describe('sign → stamp metadata → toTranscriptMessage → verify (round-trip identity)', () => {
  const slot = { conversationId: 'conv-1', turnIndex: 3, position: 0 };

  async function signAssistant(content: string, reports: TranscriptMessage['reports']) {
    const tuple: TranscriptMessage = { role: 'assistant', content, ...slot, reports };
    const signed = await attachSignature(ENV, tuple);
    const meta: SignedMeta = { sig: signed.sig!, ...slot };
    const parts: unknown[] = [text(content)];
    for (const r of reports ?? []) {
      parts.push({
        type: 'tool-emit_report',
        output: { ok: true, report: { title: r.title }, storedId: r.id },
      });
    }
    return msg('assistant', parts, meta);
  }

  it('verifies a faithfully round-tripped assistant message (with a report chip)', async () => {
    const m = await signAssistant('Ето справката.', [{ id: 'r_1', title: 'Разход 2024' }]);
    const t = toTranscriptMessage(m)!;
    expect(t.content).toBe('Ето справката.');
    expect(t.reports).toEqual([{ id: 'r_1', title: 'Разход 2024' }]);
    await expect(verifyMessage(ENV, t)).resolves.toBe(true);
  });

  it('rejects an edited body (same sig, tampered text)', async () => {
    const m = await signAssistant('Общо: 100 лв.', []);
    (m.parts[0] as { text: string }).text = 'Общо: 999 999 лв.';
    await expect(verifyMessage(ENV, toTranscriptMessage(m)!)).resolves.toBe(false);
  });

  it('rejects a re-pointed report chip (credibility laundering)', async () => {
    const m = await signAssistant('Ето справката.', [{ id: 'r_1', title: 'Разход 2024' }]);
    // Attacker keeps the verbatim prose + sig but swaps the chip to another report id.
    (m.parts[1] as { output: { storedId: string } }).output.storedId = 'r_EVIL';
    await expect(verifyMessage(ENV, toTranscriptMessage(m)!)).resolves.toBe(false);
  });

  it('rejects a replayed slot (sig valid for a different turnIndex)', async () => {
    const m = await signAssistant('Ход 3.', []);
    (m.metadata as SignedMeta).turnIndex = 5;
    await expect(verifyMessage(ENV, toTranscriptMessage(m)!)).resolves.toBe(false);
  });
});
