import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface AssistantComposerProps {
  /** Submit a (trimmed, non-empty) message. */
  onSend: (text: string) => void;
  /** Cancel the in-flight turn. */
  onStop: () => void;
  /** A turn is in flight (status 'submitted' | 'streaming') — disable input, swap Send for Stop. */
  busy: boolean;
}

/**
 * The message input. Owns its own textarea value (the chat hook owns the message list, not the draft).
 * Enter sends; Shift+Enter inserts a newline. The mic is a disabled placeholder until the voice lane
 * (Phase 3) lands.
 */
export const AssistantComposer = ({ onSend, onStop, busy }: AssistantComposerProps) => {
  const [text, setText] = useState('');
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea to fit its content (capped by the CSS max-height), and shrink back when cleared.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;
    onSend(trimmed);
    setText('');
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="assistant-composer" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={inputId}>
        Съобщение до асистента
      </label>
      <textarea
        ref={inputRef}
        id={inputId}
        className="assistant-composer__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Напишете въпрос…"
        rows={1}
        disabled={busy}
      />
      <div className="assistant-composer__actions">
        <button
          type="button"
          className="assistant-composer__mic"
          aria-label="Гласово въвеждане (скоро)"
          disabled
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
            />
          </svg>
        </button>
        {busy ? (
          <button type="button" className="assistant-composer__stop" onClick={onStop}>
            Спри
          </button>
        ) : (
          <button type="submit" className="assistant-composer__send" disabled={text.trim() === ''}>
            Изпрати
          </button>
        )}
      </div>
    </form>
  );
};
