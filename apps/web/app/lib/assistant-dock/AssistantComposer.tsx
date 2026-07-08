import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AssistantComposerMic } from './AssistantComposerMic';
import { micStatusText } from './errors';
import { useVoiceInput } from './useVoiceInput';

interface AssistantComposerProps {
  /** Submit a (trimmed, non-empty) message. */
  onSend: (text: string) => void;
  /** Cancel the in-flight turn. */
  onStop: () => void;
  /** A turn is in flight (status 'submitted' | 'streaming') — disable input, swap Send for Stop. */
  busy: boolean;
}

// The transcript-ready cue (a11y contract): announced + visible so the user knows the voice text is in the
// box and how to send it — voice never auto-sends.
const TRANSCRIPT_READY =
  'Готово. Текстът е в полето за съобщение - прегледайте го и натиснете Изпрати.';

// Append dictated text with exactly one separator — no double space when the draft already ends in whitespace.
export const appendTranscript = (prev: string, next: string): string =>
  prev === '' ? next : /\s$/.test(prev) ? `${prev}${next}` : `${prev} ${next}`;

/**
 * The message input. Owns its own textarea value (the chat hook owns the message list, not the draft).
 * Enter sends; Shift+Enter inserts a newline. Voice input records a clip, transcribes it, and appends the
 * text to the draft — editable, never auto-sent; the textarea stays usable through every mic state so a
 * user who can't type is never trapped.
 */
export const AssistantComposer = ({ onSend, onStop, busy }: AssistantComposerProps) => {
  const [text, setText] = useState('');
  const [transcriptReady, setTranscriptReady] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A finished transcript appends to the draft (with a separating space). Focus deliberately STAYS on the
  // mic button — moving it to the textarea would cut off the screen-reader announcement (a11y contract).
  const handleTranscript = useCallback((transcript: string) => {
    setText((prev) => appendTranscript(prev, transcript));
    setTranscriptReady(true);
  }, []);
  const voice = useVoiceInput(handleTranscript);

  // Wipe the whole draft in one action — easier than select-all-delete for motor/cognitive users who
  // dislike a dictated result and want to restart rather than edit it word by word.
  const clearDraft = useCallback(() => {
    setText('');
    setTranscriptReady(false);
    inputRef.current?.focus();
  }, []);

  // The composer-level status line: the active voice state, or (once idle) the transcript-ready cue.
  const voiceStatus =
    voice.state.status === 'idle'
      ? transcriptReady
        ? TRANSCRIPT_READY
        : ''
      : micStatusText(voice);

  // Grow the textarea to fit its content (capped by the CSS max-height), and shrink back when cleared.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // One source of truth for "can this draft be sent" — reused by submit, the Send button, and Clear.
  const trimmed = text.trim();
  const canSend = !busy && trimmed !== '';

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
    setTranscriptReady(false);
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
        onChange={(event) => {
          setText(event.target.value);
          setTranscriptReady(false); // editing dismisses the "ready" cue
        }}
        onKeyDown={onKeyDown}
        placeholder="Напишете въпрос…"
        rows={1}
        disabled={busy}
      />
      <div className="assistant-composer__actions">
        <AssistantComposerMic voice={voice} />
        <div className="assistant-composer__actions-end">
          {canSend ? (
            <button type="button" className="assistant-composer__clear" onClick={clearDraft}>
              Изчисти
            </button>
          ) : null}
          {busy ? (
            <button type="button" className="assistant-composer__stop" onClick={onStop}>
              Спри
            </button>
          ) : (
            <button type="submit" className="assistant-composer__send" disabled={!canSend}>
              Изпрати
            </button>
          )}
        </div>
      </div>
      <p className="assistant-composer__mic-status" role="status" aria-live="polite">
        {voiceStatus}
      </p>
    </form>
  );
};
