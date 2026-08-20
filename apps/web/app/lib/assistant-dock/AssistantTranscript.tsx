import { useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import {
  dedupHitFromMessage,
  isToolTurnWithoutReport,
  projectChip,
  reportOutputFromMessage,
} from './report-projection';
import { addToReportIndex, loadReportIndex } from './storage';
import { AssistantMessage, messageText } from './AssistantMessage';
import { AssistantPhaseLine } from './AssistantPhaseLine';
import { ReportChip } from './ReportChip';
import {
  INSUFFICIENT_DATA_MESSAGE,
  REPORT_FAILED_MESSAGE,
  type AssistantPhase,
} from '../assistant-contract/stream';
import type { DedupData } from '../../../workers/assistant/dedup-stream';

// A dedup hit carries only the report id + a reuse label. Enrich the chip with the real title / lead stat
// from this browser's report index when it generated the report (the common case); otherwise fall back to
// the reuse label. Either way „Отвори" resolves the same immutable report at /reports/:id.
const reuseChipProps = (
  dedup: DedupData,
): { title: string; leadStat: string | null; href: string } => {
  const indexed = loadReportIndex().find((entry) => entry.id === dedup.reportId);
  return {
    title: indexed?.title ?? dedup.label,
    leadStat: indexed?.leadStat ?? null,
    href: `/reports/${dedup.reportId}`,
  };
};

interface AssistantTranscriptProps {
  messages: UIMessage[];
  /** The ephemeral turn phase, rendered as a status line inside this log region. */
  phase: AssistantPhase | null;
  /** A turn is in flight. While busy, the streaming message's report result is withheld (mid-turn it
   *  may still change on retry) and the settled-turn no-answer fallback is suppressed. */
  busy: boolean;
  /** The last turn was stopped by the user. The SDK settles an aborted stream to status:ready exactly
   *  like a natural finish, so without this flag the settle announcement would falsely say „готов". */
  aborted: boolean;
  /** Called when the user taps „Отвори" — forwarded to ReportChip to close the dock on mobile. */
  onOpenReport?: () => void;
}

// Shown when a turn SETTLES having made tool calls but produced neither a report nor prose — e.g. the
// model ran out of tool steps before composing an answer. Actionable, so the reader isn't left with a
// blank turn (the root fix is elsewhere; this is the last-resort safety net).
const NO_ANSWER_FALLBACK =
  `${INSUFFICIENT_DATA_MESSAGE} Опитайте по-конкретно — напр. ` +
  'посочете възложител, период или сектор.';

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
export const AssistantTranscript = ({
  messages,
  phase,
  busy,
  aborted,
  onOpenReport,
}: AssistantTranscriptProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Turn-completion announcement (WCAG 4.1.3). The in-flight message is aria-live="off" (its text
  // mutates ~20×/s while streaming — announcing every mutation is SR spam), and flipping that
  // attribute back on settle doesn't re-announce the settled prose. This status region fills the gap:
  // one polite announcement per settled turn. Errors stay silent here — AssistantPanel's role="alert"
  // and the in-log failure lines already announce those. The toggling trailing space re-announces
  // identical consecutive messages (same trick as AssistantPanel's new-chat status).
  const prevBusy = useRef(busy);
  const settleCount = useRef(0);
  const [settledAnnouncement, setSettledAnnouncement] = useState('');
  useEffect(() => {
    const wasBusy = prevBusy.current;
    prevBusy.current = busy;
    if (!wasBusy || busy) return;
    let text: string | null = null;
    if (aborted) {
      // A user Stop settles to the same busy:false as a natural finish — announcing „готов" would
      // tell an SR user their cancelled answer completed. Checked before the role guard: an abort
      // can land before any assistant part has arrived.
      text = 'Отговорът е прекъснат';
    } else {
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return;
      const report = reportOutputFromMessage(last);
      const dedup = report ? null : dedupHitFromMessage(last);
      if (report?.ok) text = `Готова е справка: ${report.report.title}`;
      else if (dedup) text = `Готова е справка: ${reuseChipProps(dedup).title}`;
      else if (!report && messageText(last) !== '') text = 'Отговорът е готов';
    }
    if (!text) return;
    settleCount.current += 1;
    setSettledAnnouncement(`${text}${settleCount.current % 2 === 0 ? ' ' : ''}`);
  }, [busy, aborted, messages]);

  // Index each settled report so /reports can read from localStorage (spec §5: per-browser, no
  // global enumeration). Runs whenever messages change; deduplication is in addToReportIndex.
  useEffect(() => {
    for (const message of messages) {
      const output = reportOutputFromMessage(message);
      if (output?.ok && output.storedId) {
        addToReportIndex({
          id: output.storedId,
          title: output.report.title,
          question: output.report.question,
          createdAt:
            (message as { createdAt?: Date }).createdAt?.toISOString() ?? new Date().toISOString(),
          leadStat: projectChip(output.report).leadStat,
        });
      }
    }
  }, [messages]);

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
    <>
      <p className="sr-only" role="status" aria-label="Състояние на отговора">
        {settledAnnouncement}
      </p>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="assistant-transcript"
        role="log"
        aria-live="polite"
        aria-label="Разговор с асистента"
      >
        {messages.map((message, index) => {
          // Withhold the result for the still-streaming (last) message: its emit_report can settle
          // {ok:false} mid-turn and flip to a chip on retry. Show chip/failure only once the turn settles.
          const streaming = busy && index === messages.length - 1;
          const report = streaming ? null : reportOutputFromMessage(message);
          // A cache hit ran no emit_report tool; render the reuse affordance from its data-dedup part.
          const dedup = streaming || report ? null : dedupHitFromMessage(message);
          // A settled last turn that made tool calls but produced neither a report nor prose — the
          // no-answer safety net (afc93d8). `!busy` already implies the report tool isn't mid-flight.
          const showNoAnswer =
            !busy &&
            index === messages.length - 1 &&
            message.role === 'assistant' &&
            !report &&
            isToolTurnWithoutReport(message) &&
            messageText(message) === '';
          return (
            // The streaming turn is aria-live="off": its text node mutates on every token batch and
            // polite logs re-announce mutations. The settled announcement comes from the status
            // region above; the text itself stays reachable by normal SR reading order.
            <div
              key={message.id}
              className="assistant-turn"
              aria-live={streaming ? 'off' : undefined}
            >
              <AssistantMessage message={message} />
              {report?.ok ? (
                <ReportChip
                  {...projectChip(report.report)}
                  href={report.storedId ? `/reports/${report.storedId}` : undefined}
                  onOpen={onOpenReport}
                />
              ) : dedup ? (
                <ReportChip {...reuseChipProps(dedup)} onOpen={onOpenReport} />
              ) : null}
              {/* Suppress the failure line while the last turn is still in flight: a first emit that
                returns ok:false is normally RETRIED (the loop re-forces emit_report) and then
                succeeds, so flashing „не можа да бъде съставена" mid-retry contradicts the report
                that lands a moment later. Only show it once the turn has settled (or for an earlier
                turn that genuinely ended on ok:false). While busy the pending indicator shows instead. */}
              {report && !report.ok && !(busy && index === messages.length - 1) ? (
                <p className="assistant-transcript__error">{REPORT_FAILED_MESSAGE}</p>
              ) : null}
              {showNoAnswer ? (
                <p className="assistant-transcript__error">{NO_ANSWER_FALLBACK}</p>
              ) : null}
            </div>
          );
        })}
        <AssistantPhaseLine phase={phase} />
      </div>
    </>
  );
};
