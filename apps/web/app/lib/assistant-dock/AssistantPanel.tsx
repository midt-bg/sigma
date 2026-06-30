import { useState } from 'react';
import type { UIMessage } from 'ai';
import { AssistantComposer } from './AssistantComposer';
import { AssistantEmptyState } from './AssistantEmptyState';
import { AssistantTranscript } from './AssistantTranscript';
import { CloseIcon } from './CloseIcon';
import { useStarterPrompts } from './useStarterPrompts';

interface AssistantPanelProps {
  messages: UIMessage[];
  /** A turn is in flight (status 'submitted' | 'streaming'). */
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** The visitor picked a starter chip — POST its server-authored `send` question. */
  onPick: (send: string) => void;
  onCollapse: () => void;
  /** Clear the conversation and return to the empty state with fresh starter prompts. */
  onNewChat: () => void;
  onRetry: () => void;
  /** A setup/transport error to surface (the classified copy), or undefined. */
  error?: string;
}

/**
 * The dock's body — header, conversation (empty state or transcript), an error line, and the composer.
 * Purely presentational: the container (AssistantDock) owns the chat hook, collapse state, and the
 * modal/non-modal wrapper, and passes everything in.
 */
export const AssistantPanel = ({
  messages,
  busy,
  onSend,
  onStop,
  onPick,
  onCollapse,
  onNewChat,
  onRetry,
  error,
}: AssistantPanelProps) => {
  // Best-effort dynamic prompts; `undefined` until/unless the loader returns usable chips, in which
  // case the empty state falls back to its static FALLBACK_PROMPTS.
  const prompts = useStarterPrompts();

  // Announce the cleared conversation to SR; inside the panel so it works in the modal <dialog>. The
  // toggling trailing space changes the content so repeated new-chats re-announce the same message.
  const [announceCount, setAnnounceCount] = useState(0);
  const startNewChat = () => {
    setAnnounceCount((c) => c + 1);
    onNewChat();
  };
  const announcement =
    announceCount === 0 ? '' : `Започнат е нов разговор${announceCount % 2 === 0 ? ' ' : ''}`;

  return (
    <div className="assistant-panel">
      <header className="assistant-panel__header">
        <h2 className="assistant-panel__title">Асистент</h2>
        <div className="assistant-panel__actions">
          {messages.length > 0 ? (
            <button type="button" className="assistant-panel__new-chat" onClick={startNewChat}>
              Нов разговор
            </button>
          ) : null}
          <button
            type="button"
            className="assistant-panel__collapse"
            onClick={onCollapse}
            aria-label="Свий асистента"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <p className="sr-only" role="status">
        {announcement}
      </p>

      <div className="assistant-panel__body">
        {messages.length === 0 ? (
          <AssistantEmptyState prompts={prompts} onPick={onPick} />
        ) : (
          <AssistantTranscript messages={messages} />
        )}
      </div>

      {error !== undefined ? (
        <div className="assistant-panel__error" role="alert">
          <p className="assistant-panel__error-text">{error}</p>
          <button type="button" className="assistant-panel__retry" onClick={onRetry}>
            Опитайте отново
          </button>
        </div>
      ) : null}

      <AssistantComposer onSend={onSend} onStop={onStop} busy={busy} />
    </div>
  );
};
