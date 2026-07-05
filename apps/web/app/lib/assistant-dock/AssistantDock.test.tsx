import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoutesStub, Outlet } from 'react-router';
import { COLLAPSED_KEY } from './storage';
import { AssistantDock } from './AssistantDock';

// Mock the chat hook so the dock renders deterministically without the SDK / network.
const mock = vi.hoisted(() => ({
  chat: {
    messages: [] as unknown[],
    status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
    phase: null as 'thinking' | 'querying' | 'composing' | null,
    error: undefined as Error | undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    clearError: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('./useAssistantChat', () => ({ useAssistantChat: () => mock.chat }));

beforeEach(() => {
  localStorage.clear();
  mock.chat.messages = [];
  mock.chat.status = 'ready';
  mock.chat.error = undefined;
  mock.chat.sendMessage.mockClear();
  mock.chat.reset.mockClear();
  // jsdom has no matchMedia — stub it to "desktop" (the modal <dialog> path needs a real browser).
  vi.stubGlobal(
    'matchMedia',
    vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  // The empty-state panel fetches dynamic prompts on mount; stub to a miss so it uses the fallbacks.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
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

  it('clears the conversation via the new-chat button', async () => {
    const user = userEvent.setup();
    mock.chat.messages = [
      { id: '1', role: 'assistant', parts: [{ type: 'text', text: 'Отговор' }] },
    ];
    render(<AssistantDock />);

    await user.click(screen.getByRole('button', { name: 'Нов разговор' }));

    expect(mock.chat.reset).toHaveBeenCalledTimes(1);
  });

  // The ReportChip uses <Link>, so these tests need a router context. They also keep the dock mounted
  // across navigation (mimicking the root-layout pattern in root.tsx) so the collapse assertion holds.
  const reportMessage = {
    id: '1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-emit_report',
        state: 'output-available',
        output: {
          ok: true,
          report: { title: 'Справка', question: 'test', blocks: [] },
          storedId: 'r_test',
        },
      },
    ],
  };

  it('collapses the dock on mobile when „Отвори" is clicked on a report chip', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    // jsdom does not implement showModal() — define it so the focus effect can open the <dialog>
    // without throwing.
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
      writable: true,
      configurable: true,
    });
    localStorage.setItem(COLLAPSED_KEY, '0'); // force expanded; mobile default is collapsed
    mock.chat.messages = [reportMessage];
    const Stub = createRoutesStub([
      {
        path: '/',
        Component: () => (
          <>
            <AssistantDock />
            <Outlet />
          </>
        ),
        children: [{ path: 'reports/:id', Component: () => null }],
      },
    ]);
    render(<Stub />);

    await user.click(screen.getByRole('link', { name: 'Отвори' }));

    expect(screen.getByRole('button', { name: 'Асистент' })).toBeInTheDocument();
    delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
  });

  it('does not collapse the dock on desktop when „Отвори" is clicked on a report chip', async () => {
    const user = userEvent.setup();
    // matchMedia already stubbed to matches=false (desktop) in beforeEach
    mock.chat.messages = [reportMessage];
    const Stub = createRoutesStub([
      {
        path: '/',
        Component: () => (
          <>
            <AssistantDock />
            <Outlet />
          </>
        ),
        children: [{ path: 'reports/:id', Component: () => null }],
      },
    ]);
    render(<Stub />);

    await user.click(screen.getByRole('link', { name: 'Отвори' }));

    // onOpenReport is undefined on desktop — clicking „Отвори" navigates but does not collapse the dock.
    expect(screen.getByRole('button', { name: 'Свий асистента' })).toBeInTheDocument();
  });
});
