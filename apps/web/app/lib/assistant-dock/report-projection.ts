// Projection helpers between a useChat message and the dock's compact report chip (spec §1).
//
// A finished report arrives as a `tool-emit_report` part on the assistant message (contract §3); the
// chip is a projection of that report's title + one lead statistic.

import { count, date, money, pct } from '@sigma/shared';
import type { CellFormat, EmitReportOutput, ResolvedReport } from './contract';

// Minimal shape we read from a useChat UIMessage part — avoids coupling to the SDK's full part typing
// (we only ever read `type`, `state`, and `output`).
interface MessagePartLike {
  type: string;
  state?: string;
  output?: unknown;
}
interface MessageLike {
  parts?: MessagePartLike[];
}

const EMIT_REPORT_PART = 'tool-emit_report';

export interface ReportChipData {
  title: string;
  leadStat: string | null;
}

// The tool `output` crosses an untrusted boundary, so narrow it to the contract union before use rather
// than casting — a partial/unexpected object (missing `ok`) is treated as "no report" (prose fallback).
const isEmitReportOutput = (value: unknown): value is EmitReportOutput => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  if (value.ok === true) return 'report' in value && value.report != null;
  if (value.ok === false) return 'errors' in value && Array.isArray(value.errors);
  return false;
};

/**
 * The emit_report tool output from a settled part of this message, or null if the turn has no report yet
 * (prose-only, the tool is still running, or the output is malformed). Returns the `{ ok: false }` form
 * too, so the caller can surface a failure affordance.
 */
export const reportOutputFromMessage = (message: MessageLike): EmitReportOutput | null => {
  for (const part of message.parts ?? []) {
    if (
      part.type === EMIT_REPORT_PART &&
      part.state === 'output-available' &&
      part.output != null
    ) {
      return isEmitReportOutput(part.output) ? part.output : null;
    }
  }
  return null;
};

const PENDING_REPORT_STATES = new Set(['input-streaming', 'input-available']);

/**
 * True while an `emit_report` tool call is in flight (before its output settles), so the transcript can
 * show a "preparing report" affordance between the streamed prose and the finished chip.
 */
export const isReportPending = (message: MessageLike): boolean =>
  (message.parts ?? []).some(
    (part) => part.type === EMIT_REPORT_PART && PENDING_REPORT_STATES.has(part.state ?? ''),
  );

const toNumber = (value: string | number | null): number | null => {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Mirrors the foundation's render-format.formatCell so the chip's lead stat reads like the rest of the
// site (money in EUR, percent as a 0..1 ratio, blank as an em-dash).
// TODO(foundation-merge): replace with `formatCell` from `~/lib/assistant/render-format`.
const formatByHint = (value: string | number | null, format: CellFormat): string => {
  switch (format) {
    case 'money':
      return money(toNumber(value));
    case 'percent':
      return pct(toNumber(value));
    case 'number':
      return count(toNumber(value));
    case 'date':
      return date(value == null ? null : String(value));
    case 'text':
    default:
      // value is typed string | number | null, but it crosses an untrusted tool boundary; guard against
      // a non-primitive slipping through (String({}) → '[object Object]' in the chip) by showing the
      // em-dash instead.
      if (typeof value === 'string') return value === '' ? '—' : value;
      if (typeof value === 'number') return String(value);
      return '—';
  }
};

// The first totals/facts value is the most informative one-line stat; a report with neither (e.g. a bare
// table or chart) shows just the title.
const leadStat = (report: ResolvedReport): string | null => {
  for (const block of report.blocks) {
    if (block.type === 'totals' && block.items[0]) {
      const item = block.items[0];
      return `${item.label}: ${formatByHint(item.value, item.format)}`;
    }
    if (block.type === 'facts' && block.items[0]) {
      const item = block.items[0];
      return `${item.term}: ${formatByHint(item.value, 'text')}`;
    }
  }
  return null;
};

/** Project a finished report to the compact chip: its title + a single lead statistic. */
export const projectChip = (report: ResolvedReport): ReportChipData => ({
  title: report.title,
  leadStat: leadStat(report),
});
