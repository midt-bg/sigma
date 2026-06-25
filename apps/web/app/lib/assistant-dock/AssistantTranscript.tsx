import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { isReportPending, projectChip, reportOutputFromMessage } from './report-projection';
import { AssistantMessage } from './AssistantMessage';
import { ReportChip } from './ReportChip';

interface AssistantTranscriptProps {
  messages: UIMessage[];
}

// Slack (px) for "still at the bottom": absorbs sub-pixel rounding and the few px a streamed token adds
// between the scroll event and the re-render. A small constant (~2 lines), not a derived value.
const STICK_THRESHOLD_PX = 40;

/**
 * The scrolling conversation log. Per message it renders the prose (AssistantMessage) and, for a
 * finished report, a ReportChip; a "preparing report" line bridges the gap while the report is composed.
 * `role="log"` + `aria-live="polite"` announce streamed content to screen readers. It keeps the latest
 * content in view while streaming, but only while the reader is already near the bottom — so scrolling
 * up to read history isn't interrupted.
 */
export const AssistantTranscript = ({ messages }: AssistantTranscriptProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A message the visitor just sent always scrolls into view; streamed assistant tokens only follow
    // when the reader was already near the bottom, so scrolling up to read history isn't interrupted.
    const justSent = messages[messages.length - 1]?.role === 'user';
    if (justSent || stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="assistant-transcript"
      role="log"
      aria-live="polite"
      aria-label="Разговор с асистента"
    >
      {messages.map((message) => {
        const report = reportOutputFromMessage(message);
        return (
          <div key={message.id} className="assistant-turn">
            <AssistantMessage message={message} />
            {report?.ok ? <ReportChip {...projectChip(report.report)} /> : null}
            {report && !report.ok ? (
              <p className="assistant-transcript__error">Справката не можа да бъде съставена.</p>
            ) : null}
            {isReportPending(message) ? (
              <p className="assistant-transcript__pending">Подготвям справка…</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
