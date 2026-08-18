import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';

// Unlike the persistence test's mock (which ignores useChat's options), this one CAPTURES the options
// object so the test can invoke the onData callback the hook registers for transient phase parts.
const hookState = vi.hoisted(() => ({
  onData: undefined as ((part: unknown) => void) | undefined,
  messages: [] as UIMessage[],
  status: 'streaming' as string,
  setMessages: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: (opts: { onData?: (part: unknown) => void }) => {
    hookState.onData = opts.onData;
    return { ...hookState };
  },
}));

const { useAssistantChat } = await import('./useAssistantChat');

const Probe = () => {
  const { phase } = useAssistantChat();
  return <div data-testid="phase">{phase ?? 'none'}</div>;
};

beforeEach(() => {
  localStorage.clear();
  hookState.onData = undefined;
  hookState.messages = [];
  hookState.status = 'streaming';
  hookState.setMessages.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useAssistantChat phase', () => {
  it('surfaces the phase from a transient data-phase part', () => {
    render(<Probe />);

    act(() => hookState.onData?.({ type: 'data-phase', data: { phase: 'querying' } }));

    expect(screen.getByTestId('phase')).toHaveTextContent('querying');
  });

  it('ignores a non-phase data part', () => {
    render(<Probe />);

    act(() => hookState.onData?.({ type: 'data-report-ready', data: { reportId: 'x' } }));

    expect(screen.getByTestId('phase')).toHaveTextContent('none');
  });

  it('clears the phase when the turn settles', () => {
    const { rerender } = render(<Probe />);
    act(() => hookState.onData?.({ type: 'data-phase', data: { phase: 'composing' } }));
    expect(screen.getByTestId('phase')).toHaveTextContent('composing');

    hookState.status = 'ready';
    rerender(<Probe />);

    expect(screen.getByTestId('phase')).toHaveTextContent('none');
  });
});
