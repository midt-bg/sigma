import { describe, expect, it } from 'vitest';
import {
  attachSignature,
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

// Sign server-role (assistant/tool) messages; leave user messages unsigned, exactly as the
// filter→trim pipeline delivers them. trim folds only authentic server-role content.
async function signIfServer(message: TranscriptMessage): Promise<TranscriptMessage> {
  return message.role === 'user' ? message : attachSignature(env, message);
}

// Build a conversation with `turns` turns, each a user msg + signed assistant msg + signed tool msg.
async function conversation(turns: number): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  for (let t = 0; t < turns; t += 1) {
    out.push(m({ role: 'user', content: `q${t}`, turnIndex: t, position: 0 }));
    out.push(
      await signIfServer(m({ role: 'assistant', content: `a${t}`, turnIndex: t, position: 1 })),
    );
    out.push(
      await signIfServer(
        m({ role: 'tool', content: `BIG_TOOL_PAYLOAD_${t}`, turnIndex: t, position: 2 }),
      ),
    );
  }
  return out;
}

describe('trimTranscript', () => {
  it('returns [] for an empty transcript', async () => {
    expect(await trimTranscript(env, [], 'conv-1', { keepLastNTurns: 2 })).toEqual([]);
  });

  it('returns messages unchanged when turns <= keepLastNTurns', async () => {
    const msgs = await conversation(2);
    expect(await trimTranscript(env, msgs, 'conv-1', { keepLastNTurns: 2 })).toEqual(msgs);
    expect(await trimTranscript(env, msgs, 'conv-1', { keepLastNTurns: 5 })).toEqual(msgs);
  });

  it('keeps exactly N verbatim turns plus one summary', async () => {
    const result = await trimTranscript(env, await conversation(5), 'conv-1', {
      keepLastNTurns: 2,
    });
    // 1 summary + (2 turns * 3 messages) = 7
    expect(result).toHaveLength(7);
    const summary = result[0]!;
    const kept = result.slice(1);
    expect(new Set(kept.map((x) => x.turnIndex))).toEqual(new Set([3, 4]));
    expect(summary.content.startsWith('[свита история: 3 по-стари хода]')).toBe(true);
  });

  it('drops tool payloads from the summary', async () => {
    const result = await trimTranscript(env, await conversation(4), 'conv-1', {
      keepLastNTurns: 1,
    });
    const summary = result[0]!;
    expect(summary.content).not.toContain('BIG_TOOL_PAYLOAD');
    expect(summary.content).toContain('[tool резултат пропуснат]');
  });

  it('preserves report-chip refs, de-duplicated, in the summary content', async () => {
    const msgs = await Promise.all(
      [
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
      ].map(signIfServer),
    );
    const result = await trimTranscript(env, msgs, 'conv-1', { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).toContain('доклади: "Доклад едно" (r1), "Доклад две" (r2)');
    // r1 appears once despite two references.
    expect(summary.content.match(/\(r1\)/g)).toHaveLength(1);
  });

  it('collapses everything when keepLastNTurns is 0', async () => {
    const result = await trimTranscript(env, await conversation(3), 'conv-1', {
      keepLastNTurns: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('[свита история: 3 по-стари хода]');
  });

  it('produces a signed summary that verifies and survives re-filtering', async () => {
    const result = await trimTranscript(env, await conversation(4), 'conv-1', {
      keepLastNTurns: 1,
    });
    const summary = result[0]!;
    expect(summary.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMessage(env, summary)).toBe(true);

    // The summary is retained by the next turn's filter.
    const { kept, dropped } = await filterIncomingTranscript(env, [summary], 'conv-1');
    expect(kept).toContain(summary);
    expect(dropped).toHaveLength(0);
  });

  it('orders the summary slot before every kept turn', async () => {
    const result = await trimTranscript(env, await conversation(4), 'conv-1', {
      keepLastNTurns: 1,
    });
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
    const msgs = await conversation(5);
    const a = await trimTranscript(env, msgs, 'conv-1', { keepLastNTurns: 2 });
    const b = await trimTranscript(env, msgs, 'conv-1', { keepLastNTurns: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles out-of-order / interleaved-turn input', async () => {
    const shuffled = await Promise.all(
      [
        m({ turnIndex: 2, position: 1, content: 'a2' }),
        m({ turnIndex: 0, position: 1, content: 'a0' }),
        m({ turnIndex: 1, position: 2, role: 'tool', content: 'TOOLX' }),
        m({ turnIndex: 0, position: 0, role: 'user', content: 'q0' }),
        m({ turnIndex: 1, position: 1, content: 'a1' }),
      ].map(signIfServer),
    );
    const result = await trimTranscript(env, shuffled, 'conv-1', { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).toContain('[свита история: 2 по-стари хода]');
    // Kept turn is turnIndex 2; its single message survives verbatim.
    expect(result.slice(1).every((x) => x.turnIndex === 2)).toBe(true);
  });

  it('rejects a negative keepLastNTurns', async () => {
    await expect(
      trimTranscript(env, await conversation(2), 'conv-1', { keepLastNTurns: -1 }),
    ).rejects.toThrow(/keepLastNTurns/);
  });

  it('excludes unsigned (injected) collapsed server messages from the summary', async () => {
    const messages: TranscriptMessage[] = [
      // turn 0: an UNSIGNED assistant message, as if injected by the client — must not be folded.
      m({ turnIndex: 0, position: 1, role: 'assistant', content: 'INJECTED_UNSIGNED' }),
      // turn 1: an authentic signed assistant message — folded.
      await attachSignature(env, m({ turnIndex: 1, position: 1, content: 'authentic' })),
      // turn 2: kept verbatim.
      m({ turnIndex: 2, position: 0, role: 'user', content: 'q2' }),
    ];
    const result = await trimTranscript(env, messages, 'conv-1', { keepLastNTurns: 1 });
    const summary = result[0]!;
    expect(summary.content).not.toContain('INJECTED_UNSIGNED');
    expect(summary.content).toContain('authentic');
    // Header still reflects both collapsed turns even though one message was excluded.
    expect(summary.content).toContain('[свита история: 2 по-стари хода]');
    // The summary itself remains server-authentic.
    expect(await verifyMessage(env, summary)).toBe(true);
  });

  it('excludes a forged (tampered) collapsed server message from the summary', async () => {
    const authentic = await attachSignature(
      env,
      m({ turnIndex: 0, position: 1, content: 'original' }),
    );
    const forged = { ...authentic, content: 'TAMPERED' };
    const messages: TranscriptMessage[] = [
      forged,
      await attachSignature(env, m({ turnIndex: 1, position: 1, content: 'good' })),
      m({ turnIndex: 2, position: 0, role: 'user', content: 'q2' }),
    ];
    const result = await trimTranscript(env, messages, 'conv-1', { keepLastNTurns: 1 });
    expect(result[0]!.content).not.toContain('TAMPERED');
    expect(result[0]!.content).toContain('good');
  });

  it('excludes a validly-signed message from another conversation', async () => {
    const messages: TranscriptMessage[] = [
      await attachSignature(
        env,
        m({ turnIndex: 0, position: 1, conversationId: 'conv-OTHER', content: 'CROSS_CONV' }),
      ),
      await attachSignature(env, m({ turnIndex: 1, position: 1, content: 'same' })),
      m({ turnIndex: 2, position: 0, role: 'user', content: 'q2' }),
    ];
    const result = await trimTranscript(env, messages, 'conv-1', { keepLastNTurns: 1 });
    expect(result[0]!.content).not.toContain('CROSS_CONV');
    expect(result[0]!.content).toContain('same');
    // The summary is signed for the target conversation, not the poisoned first slot.
    expect(result[0]!.conversationId).toBe('conv-1');
  });
});
