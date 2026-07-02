import { afterEach, describe, expect, it } from 'vitest';
import {
  attachSignature,
  filterIncomingTranscript,
  resetKeyCache,
  signMessage,
  verifyMessage,
  type AssistantHmacEnv,
  type TranscriptMessage,
} from './transcript-hmac';

const env: AssistantHmacEnv = { ASSISTANT_HMAC_KEY: 'unit-test-key-aaaa' };
const otherEnv: AssistantHmacEnv = { ASSISTANT_HMAC_KEY: 'unit-test-key-bbbb' };

function msg(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    role: 'assistant',
    content: 'hello',
    conversationId: 'conv-1',
    turnIndex: 0,
    position: 0,
    ...overrides,
  };
}

async function signed(
  overrides: Partial<TranscriptMessage> = {},
  signEnv: AssistantHmacEnv = env,
): Promise<TranscriptMessage> {
  return attachSignature(signEnv, msg(overrides));
}

afterEach(() => {
  // Drop the module-level key cache so tests that swap key material stay order-independent.
  resetKeyCache();
});

describe('signMessage / verifyMessage', () => {
  it('round-trips a signed message', async () => {
    const m = await signed();
    expect(m.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMessage(env, m)).toBe(true);
  });

  it('is deterministic for identical input', async () => {
    const a = await signMessage(env, msg());
    const b = await signMessage(env, msg());
    expect(a).toBe(b);
  });

  it('rejects a message with no signature', async () => {
    expect(await verifyMessage(env, msg())).toBe(false);
  });

  it.each(['role', 'content', 'conversationId', 'turnIndex', 'position'] as const)(
    'fails verification when %s is tampered',
    async (field) => {
      const m = await signed();
      const tampered: TranscriptMessage = { ...m };
      if (field === 'role') tampered.role = 'tool';
      else if (field === 'content') tampered.content = 'hello.';
      else if (field === 'conversationId') tampered.conversationId = 'conv-2';
      else if (field === 'turnIndex') tampered.turnIndex = 1;
      else tampered.position = 1;
      expect(await verifyMessage(env, tampered)).toBe(false);
    },
  );

  it('fails when the signature is truncated or bit-flipped', async () => {
    const m = await signed();
    expect(await verifyMessage(env, { ...m, sig: m.sig!.slice(0, -2) })).toBe(false);
    const flipped = m.sig!.slice(0, -1) + (m.sig!.endsWith('0') ? '1' : '0');
    expect(await verifyMessage(env, { ...m, sig: flipped })).toBe(false);
  });

  it('fails when verified under a different key', async () => {
    const m = await signed({}, env);
    expect(await verifyMessage(otherEnv, m)).toBe(false);
  });

  it('cannot be forged via canonical-form field-boundary injection', async () => {
    // Two distinct tuples whose naive concatenations would collide must produce different sigs.
    const a = await signMessage(env, msg({ content: 'ab', conversationId: 'cd' }));
    const b = await signMessage(env, msg({ content: 'a', conversationId: 'bcd' }));
    expect(a).not.toBe(b);
    // A crafted content carrying a delimiter cannot impersonate another field split.
    const c = await signMessage(env, msg({ content: 'x:conv-1', conversationId: '' }));
    const d = await signMessage(env, msg({ content: 'x', conversationId: 'conv-1' }));
    expect(c).not.toBe(d);
  });

  it('binds report chips into the signature (anti credibility-laundering)', async () => {
    const withReports = await signed({ reports: [{ id: 'r1', title: 'Доклад' }] });
    expect(await verifyMessage(env, withReports)).toBe(true);
    // Retitling a chip breaks verification.
    expect(
      await verifyMessage(env, {
        ...withReports,
        reports: [{ id: 'r1', title: 'Подменено заглавие' }],
      }),
    ).toBe(false);
    // Re-pointing a chip at another report id breaks verification.
    expect(
      await verifyMessage(env, { ...withReports, reports: [{ id: 'r99', title: 'Доклад' }] }),
    ).toBe(false);
    // Adding or removing a chip breaks verification.
    expect(await verifyMessage(env, { ...withReports, reports: [] })).toBe(false);
    expect(
      await verifyMessage(env, {
        ...withReports,
        reports: [
          { id: 'r1', title: 'Доклад' },
          { id: 'r2', title: 'Втори' },
        ],
      }),
    ).toBe(false);
  });

  it('treats absent and empty report chips as the same signed message', async () => {
    expect(await signMessage(env, msg())).toBe(await signMessage(env, msg({ reports: [] })));
  });

  it('cannot forge chip field boundaries via crafted id/title', async () => {
    const a = await signMessage(env, msg({ reports: [{ id: 'ab', title: 'cd' }] }));
    const b = await signMessage(env, msg({ reports: [{ id: 'a', title: 'bcd' }] }));
    expect(a).not.toBe(b);
  });

  it('signs empty, unicode/Cyrillic, and very long content unambiguously', async () => {
    const empty = await signed({ content: '' });
    const cyrillic = await signed({ content: 'Строителство — обществена поръчка №42' });
    const long = await signed({ content: 'я'.repeat(50_000) });
    expect(await verifyMessage(env, empty)).toBe(true);
    expect(await verifyMessage(env, cyrillic)).toBe(true);
    expect(await verifyMessage(env, long)).toBe(true);
    expect(empty.sig).not.toBe(cyrillic.sig);
  });

  it('throws when the signing key is unset (fail closed)', async () => {
    await expect(signMessage({}, msg())).rejects.toThrow(/ASSISTANT_HMAC_KEY/);
  });

  it('rejects non-integer or negative slot values', async () => {
    await expect(signMessage(env, msg({ turnIndex: 1.5 }))).rejects.toThrow(/turnIndex/);
    await expect(signMessage(env, msg({ position: -1 }))).rejects.toThrow(/position/);
  });

  it('verifyMessage returns false (never throws) for a malformed slot', async () => {
    const m = await signed();
    expect(await verifyMessage(env, { ...m, position: -1 })).toBe(false);
    expect(await verifyMessage(env, { ...m, turnIndex: 1.5 })).toBe(false);
  });
});

describe('filterIncomingTranscript', () => {
  it('keeps all user messages regardless of signature', async () => {
    const messages: TranscriptMessage[] = [
      msg({ role: 'user', content: 'q1', turnIndex: 0, position: 0 }),
      msg({ role: 'user', content: 'q2', turnIndex: 1, position: 0, sig: 'garbage' }),
    ];
    const { kept, dropped } = await filterIncomingTranscript(env, messages, 'conv-1');
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('keeps authentic in-order assistant/tool messages', async () => {
    const messages = [
      msg({ role: 'user', content: 'q', turnIndex: 0, position: 0 }),
      await signed({ role: 'assistant', content: 'a', turnIndex: 0, position: 1 }),
      await signed({ role: 'tool', content: 't', turnIndex: 0, position: 2 }),
    ];
    const { kept, dropped } = await filterIncomingTranscript(env, messages, 'conv-1');
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it('drops unsigned assistant/tool messages', async () => {
    const messages = [msg({ role: 'assistant', position: 1 })];
    const { kept, dropped } = await filterIncomingTranscript(env, messages, 'conv-1');
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('unsigned');
  });

  it('drops a signed message with a malformed slot instead of throwing', async () => {
    const m = await signed({ position: 1 });
    const malformed = { ...m, position: -1 };
    const { kept, dropped } = await filterIncomingTranscript(env, [malformed], 'conv-1');
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('malformed-slot');
  });

  it('drops messages with an invalid signature', async () => {
    const m = await signed({ position: 1 });
    const tampered = { ...m, content: 'rewritten' };
    const { kept, dropped } = await filterIncomingTranscript(env, [tampered], 'conv-1');
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('invalid-signature');
  });

  it('drops a message whose report chips were tampered', async () => {
    const m = await signed({ position: 1, reports: [{ id: 'r1', title: 'Доклад' }] });
    const tampered = { ...m, reports: [{ id: 'r1', title: 'Подменено' }] };
    const { kept, dropped } = await filterIncomingTranscript(env, [tampered], 'conv-1');
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('invalid-signature');
  });

  it('drops a validly-signed message replayed from another conversation', async () => {
    const m = await signed({ conversationId: 'conv-OTHER', position: 1 });
    expect(await verifyMessage(env, m)).toBe(true);
    const { kept, dropped } = await filterIncomingTranscript(env, [m], 'conv-1');
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe('wrong-conversation');
  });

  it('drops a duplicated (turnIndex, position) as replay', async () => {
    const a = await signed({ turnIndex: 0, position: 1, content: 'first' });
    const b = await signed({ turnIndex: 0, position: 1, content: 'second' });
    const { kept, dropped } = await filterIncomingTranscript(env, [a, b], 'conv-1');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.content).toBe('first');
    expect(dropped[0]?.reason).toBe('replay');
  });

  it('drops out-of-monotonic-order assistant/tool messages', async () => {
    const a = await signed({ turnIndex: 1, position: 0, content: 'later' });
    const b = await signed({ turnIndex: 0, position: 5, content: 'earlier' });
    const { kept, dropped } = await filterIncomingTranscript(env, [a, b], 'conv-1');
    expect(kept.map((m) => m.content)).toEqual(['later']);
    expect(dropped[0]?.reason).toBe('out-of-position');
  });

  it('orders by turnIndex then position', async () => {
    const m1 = await signed({ turnIndex: 0, position: 1 });
    const m2 = await signed({ turnIndex: 0, position: 2 });
    const m3 = await signed({ turnIndex: 1, position: 0 });
    const { kept } = await filterIncomingTranscript(env, [m1, m2, m3], 'conv-1');
    expect(kept).toHaveLength(3);
  });
});
