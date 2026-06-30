import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { AssistantPanel } from './AssistantPanel';

// The panel fetches dynamic prompts on mount (useStarterPrompts). Stub fetch to a non-2xx so it falls
// back to the static FALLBACK_PROMPTS — the labels these tests assert on.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof AssistantPanel>[0];

const props = (over: Partial<Props> = {}): Props => ({
  messages: [],
  busy: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onPick: vi.fn(),
  onCollapse: vi.fn(),
  onNewChat: vi.fn(),
  onRetry: vi.fn(),
  ...over,
});

const message = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as unknown as UIMessage;

describe('AssistantPanel', () => {
  it('shows the empty state when there are no messages', () => {
    render(<AssistantPanel {...props()} />);

    expect(
      screen.getByRole('button', {
        name: 'Кои са най-големите възложители по похарчени средства?',
      }),
    ).toBeInTheDocument();
  });

  it('shows the transcript when there are messages', () => {
    render(<AssistantPanel {...props({ messages: [message('1', 'Отговор от асистента')] })} />);

    expect(screen.getByText('Отговор от асистента')).toBeInTheDocument();
  });

  it('collapses when the collapse button is clicked', async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    render(<AssistantPanel {...props({ onCollapse })} />);

    await user.click(screen.getByRole('button', { name: 'Свий асистента' }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a working retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<AssistantPanel {...props({ error: 'Нещо се обърка със заявката.', onRetry })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Нещо се обърка със заявката.');
    await user.click(screen.getByRole('button', { name: 'Опитайте отново' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables the composer while busy', () => {
    render(<AssistantPanel {...props({ busy: true })} />);

    expect(screen.getByLabelText('Съобщение до асистента')).toBeDisabled();
  });

  it('hides the new-chat button when there are no messages', () => {
    render(<AssistantPanel {...props()} />);

    expect(screen.queryByRole('button', { name: 'Нов разговор' })).not.toBeInTheDocument();
  });

  it('triggers onNewChat when the new-chat button is clicked', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    render(<AssistantPanel {...props({ messages: [message('1', 'Отговор')], onNewChat })} />);

    await user.click(screen.getByRole('button', { name: 'Нов разговор' }));

    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('announces the new conversation to screen readers', async () => {
    const user = userEvent.setup();
    render(<AssistantPanel {...props({ messages: [message('1', 'Отговор')] })} />);

    await user.click(screen.getByRole('button', { name: 'Нов разговор' }));

    expect(screen.getByRole('status')).toHaveTextContent('Започнат е нов разговор');
  });
});
