import type { UIMessage } from 'ai';

// Concatenate a message's text parts. Non-text parts (tool calls, etc.) are handled elsewhere in the
// transcript; here we only render the conversational prose.
const textOf = (message: UIMessage): string =>
  (message.parts ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');

/**
 * One conversational message (user or assistant prose). The text is rendered as plain text — React
 * escapes it and CSS preserves whitespace, so model output can never inject markup (no raw HTML, no
 * `dangerouslySetInnerHTML`). Report cards are rendered separately by the transcript.
 */
export const AssistantMessage = ({ message }: { message: UIMessage }) => {
  const text = textOf(message);
  if (text === '') return null;
  return (
    <div
      className={`assistant-message assistant-message--${message.role}`}
      data-role={message.role}
    >
      <p className="assistant-message__text">{text}</p>
    </div>
  );
};
