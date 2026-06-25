import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { TRANSCRIPT_KEY } from './storage';

// Mock useChat so the hook's restore/persist effects run against controllable state without the SDK or
// network. setMessages is a spy; messages stays the empty initial value across the mount commit.
const hookState = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: 'ready' as string,
  setMessages: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ ...hookState }) }));

const { useAssistantChat } = await import('./useAssistantChat');

const Probe = () => {
  useAssistantChat();
  return null;
};

const stored = [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'здравей' }] }];

beforeEach(() => {
  localStorage.clear();
  hookState.messages = [];
  hookState.status = 'ready';
  hookState.setMessages.mockReset();
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
});
