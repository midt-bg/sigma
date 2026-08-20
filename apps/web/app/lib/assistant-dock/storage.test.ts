import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import {
  clearTranscript,
  COLLAPSED_KEY,
  CONVERSATION_ID_KEY,
  loadCollapsed,
  loadConversationId,
  loadTranscript,
  MAX_MESSAGES,
  resetConversationId,
  saveCollapsed,
  saveTranscript,
  STORAGE_MAX_MESSAGES,
  TRANSCRIPT_KEY,
  trimMessages,
  type StorageLike,
} from './storage';

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error('storage blocked');
  },
  setItem: () => {
    throw new Error('quota exceeded');
  },
};

function msg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

beforeEach(() => {
  // Storage failures emit a dev-only warning (devWarn); silence it so test output stays clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('trimMessages', () => {
  it('keeps only the most recent N when given an explicit cap', () => {
    const msgs = ['0', '1', '2', '3', '4'].map((id) => msg(id, 'x'));

    const kept = trimMessages(msgs, 3, 1_000_000);

    expect(kept.map((m) => m.id)).toEqual(['2', '3', '4']);
  });

  it('defaults the message cap to MAX_MESSAGES', () => {
    const msgs = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => msg(String(i), 'x'));

    const kept = trimMessages(msgs);

    expect(kept).toHaveLength(MAX_MESSAGES);
    expect(kept[0]!.id).toBe('1');
  });

  it('drops oldest messages until under the byte budget', () => {
    const msgs = [
      msg('0', 'a'.repeat(1000)),
      msg('1', 'a'.repeat(1000)),
      msg('2', 'a'.repeat(1000)),
    ];

    const kept = trimMessages(msgs, 100, 2500);

    expect(kept.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('always retains the most recent message even if it alone exceeds the budget', () => {
    const kept = trimMessages([msg('a', 'z'.repeat(5000))], MAX_MESSAGES, 10);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe('a');
  });
});

describe('transcript persistence', () => {
  it('round-trips messages through storage', () => {
    const store = fakeStorage();

    saveTranscript([msg('1', 'здравей')], store);

    expect(loadTranscript(store).map((m) => m.id)).toEqual(['1']);
  });

  it('returns an empty array when nothing is stored', () => {
    expect(loadTranscript(fakeStorage())).toEqual([]);
  });

  it('persists more than the POST cap — the storage budget is the larger STORAGE_MAX_MESSAGES', () => {
    const store = fakeStorage();
    const msgs = Array.from({ length: STORAGE_MAX_MESSAGES + 5 }, (_, i) => msg(String(i), 'x'));

    saveTranscript(msgs, store);

    const kept = loadTranscript(store);
    expect(kept).toHaveLength(STORAGE_MAX_MESSAGES);
    expect(STORAGE_MAX_MESSAGES).toBeGreaterThan(MAX_MESSAGES);
    expect(kept[0]!.id).toBe('5');
  });

  it('returns an empty array on malformed JSON', () => {
    const store = fakeStorage();
    store.setItem(TRANSCRIPT_KEY, '{ not json');

    expect(loadTranscript(store)).toEqual([]);
  });

  it('returns an empty array when getItem throws (blocked storage)', () => {
    expect(loadTranscript(throwingStorage)).toEqual([]);
  });

  it('drops a stored entry that lacks a parts array', () => {
    const store = fakeStorage();
    store.setItem(TRANSCRIPT_KEY, JSON.stringify([{ id: '1', role: 'assistant' }]));

    expect(loadTranscript(store)).toEqual([]);
  });

  it('keeps valid messages and drops malformed ones', () => {
    const store = fakeStorage();
    store.setItem(
      TRANSCRIPT_KEY,
      JSON.stringify([
        { id: '1', role: 'user', parts: [] },
        { id: '2', role: 'user' },
      ]),
    );

    expect(loadTranscript(store).map((m) => m.id)).toEqual(['1']);
  });

  it('drops a stored message whose parts contain a non-object element', () => {
    const store = fakeStorage();
    store.setItem(TRANSCRIPT_KEY, JSON.stringify([{ id: '1', role: 'user', parts: [null] }]));

    expect(loadTranscript(store)).toEqual([]);
  });

  it('does not throw when setItem fails (quota/disabled)', () => {
    expect(() => saveTranscript([msg('1', 'x')], throwingStorage)).not.toThrow();
  });
});

describe('clearTranscript', () => {
  it('empties the transcript but leaves the collapsed flag intact', () => {
    const store = fakeStorage();
    saveTranscript([msg('1', 'здравей')], store);
    saveCollapsed(true, store);

    clearTranscript(store);

    expect(loadTranscript(store)).toEqual([]);
    expect(loadCollapsed(store)).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => clearTranscript(throwingStorage)).not.toThrow();
  });
});

describe('conversation id', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('mints a valid id on first read and persists it', () => {
    const store = fakeStorage();

    const id = loadConversationId(store);

    expect(id).toMatch(UUID_RE);
    expect(store.getItem(CONVERSATION_ID_KEY)).toBe(id);
  });

  it('returns the same id on every subsequent read (stable across POSTs)', () => {
    const store = fakeStorage();

    expect(loadConversationId(store)).toBe(loadConversationId(store));
  });

  it('re-mints when the stored id is malformed (rejects corrupt storage)', () => {
    const store = fakeStorage();
    store.setItem(CONVERSATION_ID_KEY, 'not a valid id!!');

    const id = loadConversationId(store);

    expect(id).toMatch(UUID_RE);
    expect(store.getItem(CONVERSATION_ID_KEY)).toBe(id);
  });

  it('mints an ephemeral id when storage is blocked', () => {
    expect(loadConversationId(throwingStorage)).toMatch(UUID_RE);
  });

  it('resetConversationId replaces the id with a fresh one', () => {
    const store = fakeStorage();
    const first = loadConversationId(store);

    resetConversationId(store);
    const second = loadConversationId(store);

    expect(second).toMatch(UUID_RE);
    expect(second).not.toBe(first);
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => resetConversationId(throwingStorage)).not.toThrow();
  });
});

describe('collapsed flag persistence', () => {
  it('persists a collapsed=true flag', () => {
    const store = fakeStorage();

    saveCollapsed(true, store);

    expect(loadCollapsed(store)).toBe(true);
  });

  it('overwrites a stored flag with collapsed=false', () => {
    const store = fakeStorage();
    store.setItem(COLLAPSED_KEY, '1');

    saveCollapsed(false, store);

    expect(loadCollapsed(store)).toBe(false);
  });

  it('returns null when no flag is stored', () => {
    expect(loadCollapsed(fakeStorage())).toBeNull();
  });
});
