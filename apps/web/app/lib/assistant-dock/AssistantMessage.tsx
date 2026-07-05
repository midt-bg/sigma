import type { UIMessage } from 'ai';

// Return the visible text of a message — conversational prose only.
//
// Two sources of noise are filtered:
//
// 1. PRE-TOOL PREAMBLE — The Gemma-based BgGPT model uses text-based tool calling: it writes a
//    sentence or partial table ("| Изпълнител…") before embedding the <tool_call> tag. That text
//    becomes a TextUIPart before the first ToolUIPart. Primary strategy: prefer text that appears
//    AFTER the last tool-call/tool-result part. Exception: if the post-tool text is shorter than
//    MIN_LEN characters (a stray fragment like "ума"), fall back to pre-tool preamble prose if it
//    is substantial and does not start with '|' (i.e. is not a partial markdown table).
//
// 2. TOOL-RESPONSE ECHO — After emit_report the model sometimes echoes the raw JSON result wrapped
//    in <tool_response>…</tool_response>. Those parts are detected and discarded.
const isToolResponseEcho = (text: string): boolean =>
  text.trimStart().startsWith('<tool_response>');

// Also reused by condense.ts — the recap bullets share the same notion of "visible prose".
export const messageText = (message: UIMessage): string => {
  const parts = message.parts ?? [];

  // Index of the last non-text, non-step-start part (i.e. any tool invocation / tool result).
  let lastToolIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].type;
    if (t !== 'text' && t !== 'step-start') lastToolIdx = i;
  }

  const extractText = (slice: typeof parts) =>
    slice
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

  // Text before the last tool part is pre-tool preamble — discard it by default.
  const postTool = extractText(parts.slice(lastToolIdx + 1));

  // A short post-tool fragment (the model emitted a stray token after the last tool result, e.g.
  // "ума") is meaningless. Fall back to the pre-tool preamble: the Gemma-based model often writes
  // the actual summary prose BEFORE its first tool call. Skip preambles starting with `|` (partial
  // markdown tables — the confusing case the original preamble-discard rule was written to prevent).
  const MIN_LEN = 10;
  if (lastToolIdx >= 0 && postTool.length > 0 && postTool.length < MIN_LEN) {
    let firstToolIdx = parts.length;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'text' && parts[i].type !== 'step-start') {
        firstToolIdx = i;
        break;
      }
    }
    const preTool = extractText(parts.slice(0, firstToolIdx));
    if (preTool.length >= MIN_LEN && !preTool.startsWith('|')) return preTool;
    return '';
  }

  return postTool;
};

/**
 * One conversational message (user or assistant prose). The text is rendered as plain text — React
 * escapes it and CSS preserves whitespace, so model output can never inject markup (no raw HTML, no
 * `dangerouslySetInnerHTML`). Report cards are rendered separately by the transcript.
 */
export const AssistantMessage = ({ message }: { message: UIMessage }) => {
  const text = messageText(message);
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
