import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCollapsed, saveCollapsed } from './storage';
import { useAssistantChat } from './useAssistantChat';
import { AssistantLauncher } from './AssistantLauncher';
import { AssistantPanel } from './AssistantPanel';

// Below the site's primary mobile breakpoint (760px — where the layout goes single-column) a 400px
// docked panel would cover most of the viewport, so the dock becomes a full-screen modal sheet instead.
// Kept identical to the CSS `@media (max-width: 760px)` so the JS-chosen element and its styles agree.
const MOBILE_QUERY = '(max-width: 760px)';

/**
 * The always-on chat dock, mounted once in root.tsx. It owns the chat hook + the collapse state and
 * wraps the panel in a native modal `<dialog>` on mobile (real focus trap + inert + Esc + backdrop) or a
 * non-modal `<aside role="complementary">` on desktop. Mount-gated so the server (and first client
 * render) emit nothing — no hydration mismatch, no collapse flash.
 *
 * Every hook runs unconditionally, before the `!mounted` early return (Rules of React).
 */
export const AssistantDock = () => {
  const chat = useAssistantChat();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<'launcher' | 'panel' | null>(null);
  const pendingNewChatFocus = useRef(false);
  const setWrapper = useCallback((el: HTMLElement | null) => {
    wrapperRef.current = el;
  }, []);

  const persistCollapsed = (next: boolean) => {
    setCollapsed(next);
    saveCollapsed(next);
  };
  const expand = () => {
    pendingFocus.current = 'panel';
    persistCollapsed(false);
  };
  const collapse = () => {
    pendingFocus.current = 'launcher';
    persistCollapsed(true);
  };
  const retry = () => {
    chat.clearError();
    void chat.regenerate();
  };
  const newChat = () => {
    pendingNewChatFocus.current = true;
    chat.reset();
  };

  // Client-only: mount, then restore the collapse state. With no stored preference the dock opens on
  // desktop but stays collapsed on mobile — the full-screen sheet is launcher-toggled (spec §1), not
  // auto-opened modally on every page load. A stored preference always wins.
  useEffect(() => {
    setMounted(true);
    const stored = loadCollapsed();
    setCollapsed(stored ?? window.matchMedia(MOBILE_QUERY).matches);
  }, []);

  // Track the mobile breakpoint (modal sheet vs docked panel).
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Focus across collapse/expand: open the mobile sheet modally (native focus), focus the input when the
  // desktop panel opens, and return focus to the launcher when collapsing.
  useEffect(() => {
    if (!mounted) return;
    if (collapsed) {
      if (pendingFocus.current === 'launcher') launcherRef.current?.focus();
    } else {
      const wrapper = wrapperRef.current;
      if (wrapper instanceof HTMLDialogElement) {
        // showModal() IS the sheet's focus trap (native trap + inert background + Esc). Guarded:
        // an engine without it must not throw here — open the dialog non-modally instead (a closed
        // <dialog> is display:none, so the sheet would otherwise never render) and focus the
        // composer, leaving the sheet open but untrapped.
        if (typeof wrapper.showModal === 'function') {
          if (!wrapper.open) wrapper.showModal();
        } else {
          if (!wrapper.open) {
            if (typeof wrapper.show === 'function') wrapper.show();
            else wrapper.open = true;
          }
          wrapper.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        }
      } else if (pendingFocus.current === 'panel') {
        wrapper?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
      }
    }
    pendingFocus.current = null;
  }, [collapsed, isMobile, mounted]);

  // Esc collapses the expanded dock. The native modal sheet also fires cancel → collapse(); the
  // double call is idempotent. Active on mobile too so the no-showModal fallback (non-modal
  // dialog, which fires NO cancel on Esc) can still be closed by keyboard (WCAG 2.1.2).
  useEffect(() => {
    if (collapsed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') collapse();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [collapsed]);

  // Focus the composer after a new chat — deferred, since the textarea is disabled until the aborted
  // turn settles; the ref one-shots it so later turns don't steal focus.
  useEffect(() => {
    if (!pendingNewChatFocus.current) return;
    if (chat.status === 'submitted' || chat.status === 'streaming') return;
    wrapperRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    pendingNewChatFocus.current = false;
  }, [chat.status, chat.messages.length]);

  // The desktop panel pushes the page aside in CSS so it never obscures focused page content
  // (WCAG 2.2 §2.4.11 Focus Not Obscured). This effect only arms that push's transition one frame after
  // the panel mounts, so the default-open push is instant on load and only user toggles animate.
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    const raf = requestAnimationFrame(() => root.classList.add('assistant-ready'));

    return () => {
      cancelAnimationFrame(raf);
      root.classList.remove('assistant-ready');
    };
  }, [mounted]);

  if (!mounted) return null;

  if (collapsed) {
    return <AssistantLauncher ref={launcherRef} onOpen={expand} />;
  }

  const panel = (
    <AssistantPanel
      messages={chat.messages}
      busy={chat.status === 'submitted' || chat.status === 'streaming'}
      aborted={chat.aborted}
      phase={chat.phase}
      onSend={(text) => chat.sendMessage({ text })}
      onStop={chat.stop}
      onPick={(prompt) => chat.sendMessage({ text: prompt })}
      onCollapse={collapse}
      onOpenReport={isMobile ? collapse : undefined}
      onNewChat={newChat}
      onRetry={retry}
      error={chat.error?.message}
    />
  );

  return isMobile ? (
    <dialog
      ref={setWrapper}
      className="assistant-dock assistant-dock--sheet"
      aria-label="Асистент"
      onCancel={(event) => {
        event.preventDefault();
        collapse();
      }}
    >
      {panel}
    </dialog>
  ) : (
    <aside
      ref={setWrapper}
      className="assistant-dock assistant-dock--panel"
      role="complementary"
      aria-label="Асистент"
    >
      {panel}
    </aside>
  );
};
