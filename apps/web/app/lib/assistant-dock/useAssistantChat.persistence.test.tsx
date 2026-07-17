import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { TRANSCRIPT_KEY } from './storage';

// Mock useChat so the hook's restore/persist effects run against controllable state without the SDK or
// network. setMessages is a spy; messages stays the empty initial value across the mount commit.
const hookState = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: 'ready' as string,
  setMessages: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ ...hookState }) }));

const { useAssistantChat } = await import('./useAssistantChat');

let api: ReturnType<typeof useAssistantChat> | undefined;
const Probe = () => {
  api = useAssistantChat();
  return null;
};

const stored = [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'здравей' }] }];

beforeEach(() => {
  localStorage.clear();
  hookState.messages = [];
  hookState.status = 'ready';
  hookState.setMessages.mockReset();
  hookState.stop.mockReset();
  hookState.clearError.mockReset();
  hookState.sendMessage.mockReset();
  api = undefined;
});

afterEach(() => {
  cleanup();
});

describe('useAssistantChat persistence', () => {
  it('does not overwrite the stored transcript with an empty array on mount', () => {
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(stored));

    render(<Probe />);

    expect(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY)!)).toEqual(stored);
  });

  it('restores the stored transcript via setMessages on mount', () => {
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(stored));

    render(<Probe />);

    expect(hookState.setMessages).toHaveBeenCalledWith(stored);
  });

  it('reset() clears storage and a turn settling afterwards does not resurrect it', () => {
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(stored));
    hookState.messages = stored as UIMessage[];
    hookState.status = 'ready';
    const { rerender } = render(<Probe />);

    // The user starts a new chat — storage is cleared immediately.
    act(() => api!.reset());
    expect(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY)!)).toEqual([]);

    // The aborted turn settles a frame later (stop() is fire-and-forget) with content + status 'ready'.
    hookState.messages = [
      { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
    ] as UIMessage[];
    hookState.status = 'ready';
    rerender(<Probe />);

    // The guard must keep storage cleared rather than re-saving the superseded turn.
    expect(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY)!)).toEqual([]);
  });

  it('reverts the in-memory transcript when a turn settles after reset', () => {
    hookState.messages = stored as UIMessage[];
    hookState.status = 'ready';
    const { rerender } = render(<Probe />);

    act(() => api!.reset());
    hookState.setMessages.mockClear(); // ignore reset()'s own setMessages([])

    // A late throttled flush from the aborted turn repopulates messages.
    hookState.messages = [
      { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
    ] as UIMessage[];
    hookState.status = 'ready';
    rerender(<Probe />);

    // The suppress branch clears the in-memory transcript so the cleared conversation doesn't reappear.
    expect(hookState.setMessages).toHaveBeenCalledWith([]);
  });

  it('persists again once a new message is sent after a reset', () => {
    hookState.messages = stored as UIMessage[];
    const { rerender } = render(<Probe />);

    act(() => api!.reset());
    // A new turn lifts the post-reset suppression…
    act(() => {
      api!.sendMessage({ text: 'нов въпрос' });
    });
    // …so when it settles with content, persistence resumes.
    hookState.messages = [
      { id: '2', role: 'user', parts: [{ type: 'text', text: 'нов въпрос' }] },
    ] as UIMessage[];
    hookState.status = 'ready';
    rerender(<Probe />);

    expect(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY)!).map((m: UIMessage) => m.id)).toEqual([
      '2',
    ]);
  });
});
