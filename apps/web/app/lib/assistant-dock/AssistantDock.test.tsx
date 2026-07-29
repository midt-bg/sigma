import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoutesStub, Outlet } from 'react-router';
import { COLLAPSED_KEY } from './storage';
import { AssistantDock } from './AssistantDock';

// Mock the chat hook so the dock renders deterministically without the SDK / network.
const mock = vi.hoisted(() => ({
  chat: {
    messages: [] as unknown[],
    status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
    aborted: false,
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

// jsdom does not implement showModal() — define it so the focus effect can open the <dialog>
// without throwing. Callers MUST pair with removeShowModal via afterEach/finally: a leaked
// prototype patch would silently invalidate the no-showModal fallback tests.
const defineShowModal = () => {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    value: showModal,
    writable: true,
    configurable: true,
  });
  return showModal;
};

const removeShowModal = () => {
  delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
};

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
    defineShowModal();
    try {
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
    } finally {
      removeShowModal();
    }
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

  // H5 lock-ins: the dock's keyboard/focus contract (Esc, focus return, composer focus) and the
  // mobile sheet's native-dialog focus trap, including the guarded no-showModal fallback.
  describe('focus and keyboard', () => {
    const stubMobile = () => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn().mockReturnValue({
          matches: true,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
      );
    };

    it('desktop: Escape collapses the panel and returns focus to the launcher', async () => {
      const user = userEvent.setup();
      render(<AssistantDock />);
      expect(screen.getByRole('button', { name: 'Свий асистента' })).toBeInTheDocument();

      await user.keyboard('{Escape}');

      const launcher = screen.getByRole('button', { name: 'Асистент' });
      expect(document.activeElement).toBe(launcher);
    });

    it('desktop: expanding from the launcher focuses the composer textarea', async () => {
      const user = userEvent.setup();
      localStorage.setItem(COLLAPSED_KEY, '1');
      render(<AssistantDock />);

      await user.click(screen.getByRole('button', { name: 'Асистент' }));

      expect(document.activeElement).toBe(screen.getByRole('textbox'));
    });

    // Prototype patches must be applied/removed via hooks, not inline calls: an assertion failure
    // mid-test would otherwise leak the stub into the no-showModal describe below.
    describe('mobile, with native showModal', () => {
      let showModal: ReturnType<typeof defineShowModal>;

      beforeEach(() => {
        showModal = defineShowModal();
      });

      afterEach(() => {
        removeShowModal();
      });

      it('expanding opens the sheet modally via showModal (the native focus trap)', async () => {
        const user = userEvent.setup();
        stubMobile();
        render(<AssistantDock />);

        await user.click(screen.getByRole('button', { name: 'Асистент' }));

        expect(showModal).toHaveBeenCalled();
      });

      it('the dialog cancel event (Esc) collapses and returns focus to the launcher', async () => {
        const user = userEvent.setup();
        stubMobile();
        const { container } = render(<AssistantDock />);
        await user.click(screen.getByRole('button', { name: 'Асистент' }));

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        fireEvent(dialog!, new Event('cancel', { bubbles: false, cancelable: true }));

        const launcher = screen.getByRole('button', { name: 'Асистент' });
        expect(document.activeElement).toBe(launcher);
      });
    });

    describe('mobile, without showModal support (guarded fallback)', () => {
      // Premise guard: these tests are only meaningful on a dialog WITHOUT showModal. A stub
      // leaked from another test would silently invert them — fail loudly instead.
      beforeEach(() => {
        expect('showModal' in HTMLDialogElement.prototype).toBe(false);
      });

      it('expanding does not crash and still focuses the composer', async () => {
        const user = userEvent.setup();
        stubMobile();
        render(<AssistantDock />);

        await user.click(screen.getByRole('button', { name: 'Асистент' }));

        expect(document.activeElement).toBe(screen.getByRole('textbox'));
      });

      it('Escape closes the non-modally opened sheet and returns focus to the launcher', async () => {
        // A non-modal <dialog> fires no cancel on Esc, so the document-level Esc listener must
        // cover the fallback sheet — otherwise it cannot be closed by keyboard (WCAG 2.1.2).
        const user = userEvent.setup();
        stubMobile();
        render(<AssistantDock />);
        await user.click(screen.getByRole('button', { name: 'Асистент' }));
        expect(document.activeElement).toBe(screen.getByRole('textbox'));

        await user.keyboard('{Escape}');

        const launcher = screen.getByRole('button', { name: 'Асистент' });
        expect(document.activeElement).toBe(launcher);
      });
    });
  });
});
