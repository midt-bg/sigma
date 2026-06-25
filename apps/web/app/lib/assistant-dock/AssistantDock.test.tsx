import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COLLAPSED_KEY } from './storage';
import { AssistantDock } from './AssistantDock';

// Mock the chat hook so the dock renders deterministically without the SDK / network.
const mock = vi.hoisted(() => ({
  chat: {
    messages: [] as unknown[],
    status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
    error: undefined as Error | undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    clearError: vi.fn(),
  },
}));

vi.mock('./useAssistantChat', () => ({ useAssistantChat: () => mock.chat }));

beforeEach(() => {
  localStorage.clear();
  mock.chat.messages = [];
  mock.chat.status = 'ready';
  mock.chat.error = undefined;
  mock.chat.sendMessage.mockClear();
  // jsdom has no matchMedia — stub it to "desktop" (the modal <dialog> path needs a real browser).
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssistantDock', () => {
  it('starts expanded by default, showing the panel', () => {
    render(<AssistantDock />);

    expect(screen.getByRole('button', { name: 'Свий асистента' })).toBeInTheDocument();
  });

  it('collapses to the launcher and re-opens', async () => {
    const user = userEvent.setup();
    render(<AssistantDock />);

    await user.click(screen.getByRole('button', { name: 'Свий асистента' }));
    expect(screen.getByRole('button', { name: 'Асистент' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Асистент' }));
    expect(screen.getByRole('button', { name: 'Свий асистента' })).toBeInTheDocument();
  });

  it('restores the collapsed state from storage', () => {
    localStorage.setItem(COLLAPSED_KEY, '1');

    render(<AssistantDock />);

    expect(screen.getByRole('button', { name: 'Асистент' })).toBeInTheDocument();
  });

  it('starts collapsed on mobile when no preference is stored', () => {
    // Mobile viewport: the full-screen sheet is launcher-toggled, so the dock must not auto-open.
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );

    render(<AssistantDock />);

    expect(screen.getByRole('button', { name: 'Асистент' })).toBeInTheDocument();
  });

  it('sends an example prompt through the chat hook', async () => {
    const user = userEvent.setup();
    render(<AssistantDock />);

    await user.click(
      screen.getByRole('button', {
        name: 'Кои са най-големите възложители по похарчени средства?',
      }),
    );

    expect(mock.chat.sendMessage).toHaveBeenCalledWith({
      text: 'Кои са най-големите възложители по похарчени средства?',
    });
  });
});
