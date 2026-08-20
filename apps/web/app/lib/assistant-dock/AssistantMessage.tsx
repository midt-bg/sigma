import type { UIMessage } from 'ai';
import { MarkdownBlock } from '~/components/MarkdownBlock';

// Return the visible text of a message — conversational prose only.
//
// Two sources of noise are filtered:
//
// 1. PRE-TOOL PREAMBLE — The Gemma-based BgGPT model uses text-based tool calling: it writes a
//    sentence or partial table ("| Изпълнител…") before embedding the <tool_call> tag. That text
//    becomes a TextUIPart before the first ToolUIPart. Primary strategy: prefer text that appears
//    AFTER the last tool-call/tool-result part. Exception: if the post-tool text is shorter than
//    MIN_LEN characters — including the empty case, where the model wrote its whole summary before
//    the <tool_call> and emitted nothing after — fall back to pre-tool preamble prose if it is
//    substantial and does not start with '|' (i.e. is not a partial markdown table).
//
// 2. LEAKED TOOL/REPORT MARKUP — the model sometimes writes structural pseudo-XML into a TEXT part
//    instead of (or alongside) a real tool part: a <tool_response> echo of the JSON result, a malformed
//    <tool_call>, or a <report>…</report> block narrating emit_report's output. MarkdownBlock renders
//    unknown tags as inert literal text, so left in, it surfaces raw "<report>…" tags in the dock. Strip
//    each known block (opener→closer) plus any dangling opener→end left by a mid-stream truncation. ONLY
//    these three structural tags — user-facing angle-bracket prose like "<ЕИК>" is deliberately preserved.
const stripLeakedMarkup = (text: string): string =>
  text
    .replace(/<(report|tool_call|tool_response)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(report|tool_call|tool_response)\b[\s\S]*$/i, '');

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
        return stripLeakedMarkup(s);
      })
      .join('')
      .trim();

  // Text before the last tool part is pre-tool preamble — discard it by default.
  const postTool = extractText(parts.slice(lastToolIdx + 1));

  // A short or empty post-tool result is unusable: either the model emitted a stray token after the
  // last tool result (e.g. "ума"), or it wrote nothing after the tool call at all. In both cases fall
  // back to the pre-tool preamble — the Gemma-based model often writes the actual summary prose BEFORE
  // its first tool call, so an empty post-tool text must not silently drop that summary. Skip preambles
  // starting with `|` (partial markdown tables — the case the original preamble-discard rule prevents).
  const MIN_LEN = 10;
  if (lastToolIdx >= 0 && postTool.length < MIN_LEN) {
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
 * One conversational message. ASSISTANT prose is rendered through MarkdownBlock (a safe subset — bold,
 * italic, code, links, lists, hr, tables — as React elements only: no raw HTML, no
 * `dangerouslySetInnerHTML`, link hrefs allow-listed). USER echo stays verbatim plain text so what the
 * user typed is shown exactly. Report cards are rendered separately by the transcript.
 */
export const AssistantMessage = ({ message }: { message: UIMessage }) => {
  const text = messageText(message);
  if (text === '') return null;
  return (
    <div
      className={`assistant-message assistant-message--${message.role}`}
      data-role={message.role}
    >
      {message.role === 'assistant' ? (
        <MarkdownBlock md={text} className="assistant-message__text" />
      ) : (
        <p className="assistant-message__text">{text}</p>
      )}
    </div>
  );
};
