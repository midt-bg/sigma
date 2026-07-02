import type { UIMessage } from 'ai';

// Return the visible text of a message — conversational prose only.
//
// Two sources of noise are filtered:
//
// 1. PRE-TOOL PREAMBLE — The Gemma-based BgGPT model uses text-based tool calling: it writes a
//    sentence or partial table ("| Изпълнител…") before embedding the <tool_call> tag. That text
//    becomes a TextUIPart before the first ToolUIPart. Because the report chip already shows the
//    result, surfacing a truncated preamble is confusing. Fix: only return text that appears AFTER
//    the last tool-call/tool-result part in the parts array.
//
// 2. TOOL-RESPONSE ECHO — After emit_report the model sometimes echoes the raw JSON result wrapped
//    in <tool_response>…</tool_response>. Those parts are detected and discarded.
const isToolResponseEcho = (text: string): boolean =>
  text.trimStart().startsWith('<tool_response>');

const textOf = (message: UIMessage): string => {
  const parts = message.parts ?? [];

  // Index of the last non-text, non-step-start part (i.e. any tool invocation / tool result).
  let lastToolIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].type;
    if (t !== 'text' && t !== 'step-start') lastToolIdx = i;
  }

  // Text before the last tool part is pre-tool preamble — discard it.
  return parts
    .slice(lastToolIdx + 1)
    .map((part) => {
      if (part.type !== 'text') return '';
      const s =
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '';
      return isToolResponseEcho(s) ? '' : s;
    })
    .join('')
    .trim();
};

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
