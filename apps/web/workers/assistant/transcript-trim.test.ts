import { describe, expect, it } from 'vitest';
import {
  filterIncomingTranscript,
  verifyMessage,
  type AssistantHmacEnv,
  type TranscriptMessage,
} from './transcript-hmac';
import { trimTranscript } from './transcript-trim';

const env: AssistantHmacEnv = { ASSISTANT_HMAC_KEY: 'trim-test-key' };

function m(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    role: 'assistant',
    content: 'c',
    conversationId: 'conv-1',
    turnIndex: 0,
    position: 0,
    ...overrides,
  };
}

// Build a conversation with `turns` turns, each a user msg + assistant msg + tool msg.
function conversation(turns: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let t = 0; t < turns; t += 1) {
    out.push(m({ role: 'user', content: `q${t}`, turnIndex: t, position: 0 }));
    out.push(m({ role: 'assistant', content: `a${t}`, turnIndex: t, position: 1 }));
    out.push(m({ role: 'tool', content: `BIG_TOOL_PAYLOAD_${t}`, turnIndex: t, position: 2 }));
  }
  return out;
}

describe('trimTranscript', () => {
  it('returns [] for an empty transcript', async () => {
    expect(await trimTranscript(env, [], { keepLastNTurns: 2 })).toEqual([]);
  });

  it('returns messages unchanged when turns <= keepLastNTurns', async () => {
    const msgs = conversation(2);
    expect(await trimTranscript(env, msgs, { keepLastNTurns: 2 })).toEqual(msgs);
    expect(await trimTranscript(env, msgs, { keepLastNTurns: 5 })).toEqual(msgs);
  });

  it('keeps exactly N verbatim turns plus one summary', async () => {
    const result = await trimTranscript(env, conversation(5), { keepLastNTurns: 2 });
    // 1 summary + (2 turns * 3 messages) = 7
    expect(result).toHaveLength(7);
    const summary = result[0]!;
    const kept = result.slice(1);
    expect(new Set(kept.map((x) => x.turnIndex))).toEqual(new Set([3, 4]));
    expect(summary.content.startsWith('[свита история: 3 по-стари хода]')).toBe(true);
  });

  it('drops tool payloads from the summary', async () => {
    const result = await trimTranscript(env, conversation(4), { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).not.toContain('BIG_TOOL_PAYLOAD');
    expect(summary.content).toContain('[tool резултат пропуснат]');
  });

  it('preserves report-chip refs, de-duplicated, in the summary content', async () => {
    const msgs: TranscriptMessage[] = [
      m({
        turnIndex: 0,
        position: 1,
        content: 'a0',
        reports: [{ id: 'r1', title: 'Доклад едно' }],
      }),
      m({
        turnIndex: 1,
        position: 1,
        content: 'a1',
        reports: [
          { id: 'r1', title: 'Доклад едно' },
          { id: 'r2', title: 'Доклад две' },
        ],
      }),
      m({ turnIndex: 2, position: 0, role: 'user', content: 'q2' }),
    ];
    const result = await trimTranscript(env, msgs, { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).toContain('доклади: "Доклад едно" (r1), "Доклад две" (r2)');
    // r1 appears once despite two references.
    expect(summary.content.match(/\(r1\)/g)).toHaveLength(1);
  });

  it('collapses everything when keepLastNTurns is 0', async () => {
    const result = await trimTranscript(env, conversation(3), { keepLastNTurns: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('[свита история: 3 по-стари хода]');
  });

  it('produces a signed summary that verifies and survives re-filtering', async () => {
    const result = await trimTranscript(env, conversation(4), { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMessage(env, summary)).toBe(true);

    // Re-sign the kept assistant/tool messages so the whole trimmed transcript is server-authentic,
    // then confirm the summary is retained by the next turn's filter.
    const { kept, dropped } = await filterIncomingTranscript(env, [summary], 'conv-1');
    expect(kept).toContain(summary);
    expect(dropped).toHaveLength(0);
  });

  it('orders the summary slot before every kept turn', async () => {
    const result = await trimTranscript(env, conversation(4), { keepLastNTurns: 1 });
    const summary = result[0]!;
    const kept = result.slice(1);
    for (const k of kept) {
      const before =
        summary.turnIndex < k.turnIndex ||
        (summary.turnIndex === k.turnIndex && summary.position < k.position);
      expect(before).toBe(true);
    }
  });

  it('is deterministic — identical input yields identical output', async () => {
    const msgs = conversation(5);
    const a = await trimTranscript(env, msgs, { keepLastNTurns: 2 });
    const b = await trimTranscript(env, msgs, { keepLastNTurns: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles out-of-order / interleaved-turn input', async () => {
    const shuffled = [
      m({ turnIndex: 2, position: 1, content: 'a2' }),
      m({ turnIndex: 0, position: 1, content: 'a0' }),
      m({ turnIndex: 1, position: 2, role: 'tool', content: 'TOOLX' }),
      m({ turnIndex: 0, position: 0, role: 'user', content: 'q0' }),
      m({ turnIndex: 1, position: 1, content: 'a1' }),
    ];
    const result = await trimTranscript(env, shuffled, { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).toContain('[свита история: 2 по-стари хода]');
    // Kept turn is turnIndex 2; its single message survives verbatim.
    expect(result.slice(1).every((x) => x.turnIndex === 2)).toBe(true);
  });

  it('rejects a negative keepLastNTurns', async () => {
    await expect(trimTranscript(env, conversation(2), { keepLastNTurns: -1 })).rejects.toThrow(
      /keepLastNTurns/,
    );
  });
});
