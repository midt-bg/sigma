import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';

// The SDK gives no abort signal: after stop() the status goes streaming → ready exactly like a
// natural settle (classifyingFetch swallows the AbortError on purpose). The hook must therefore
// mint its own `aborted` flag when the user stops a busy turn — these tests pin that contract.
const hookState = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: 'streaming' as string,
  setMessages: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ ...hookState }),
}));

const { useAssistantChat } = await import('./useAssistantChat');

let api: ReturnType<typeof useAssistantChat>;
const Probe = () => {
  api = useAssistantChat();
  return <div data-testid="aborted">{String(api.aborted)}</div>;
};

beforeEach(() => {
  localStorage.clear();
  hookState.messages = [];
  hookState.status = 'streaming';
  hookState.setMessages.mockReset();
  hookState.stop.mockReset();
  hookState.clearError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useAssistantChat aborted flag', () => {
  it('is false initially', () => {
    render(<Probe />);

    expect(screen.getByTestId('aborted')).toHaveTextContent(/^false$/);
  });

  it('flips true when the user stops a busy turn, delegating to the SDK stop', () => {
    render(<Probe />);

    act(() => void api.stop());

    expect(screen.getByTestId('aborted')).toHaveTextContent(/^true$/);
    expect(hookState.stop).toHaveBeenCalledTimes(1);
  });

  it('does NOT flip when stop is called while idle (no turn to abort)', () => {
    hookState.status = 'ready';
    render(<Probe />);

    act(() => void api.stop());

    expect(screen.getByTestId('aborted')).toHaveTextContent(/^false$/);
    expect(hookState.stop).toHaveBeenCalledTimes(1);
  });

  it('clears when the next turn starts', () => {
    const { rerender } = render(<Probe />);
    act(() => void api.stop());
    expect(screen.getByTestId('aborted')).toHaveTextContent(/^true$/);

    hookState.status = 'submitted';
    rerender(<Probe />);

    expect(screen.getByTestId('aborted')).toHaveTextContent(/^false$/);
  });

  it('clears on reset (new chat)', () => {
    render(<Probe />);
    act(() => void api.stop());
    expect(screen.getByTestId('aborted')).toHaveTextContent(/^true$/);

    act(() => api.reset());

    expect(screen.getByTestId('aborted')).toHaveTextContent(/^false$/);
  });
});
