import type { UIMessage } from 'ai';
import { AssistantComposer } from './AssistantComposer';
import { AssistantEmptyState } from './AssistantEmptyState';
import { AssistantTranscript } from './AssistantTranscript';

interface AssistantPanelProps {
  messages: UIMessage[];
  /** A turn is in flight (status 'submitted' | 'streaming'). */
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onPick: (prompt: string) => void;
  onCollapse: () => void;
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
  onRetry,
  error,
}: AssistantPanelProps) => (
  <div className="assistant-panel">
    <header className="assistant-panel__header">
      <h2 className="assistant-panel__title">Асистент</h2>
      <button
        type="button"
        className="assistant-panel__collapse"
        onClick={onCollapse}
        aria-label="Свий асистента"
      >
        ×
      </button>
    </header>

    <div className="assistant-panel__body">
      {messages.length === 0 ? (
        <AssistantEmptyState onPick={onPick} />
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
