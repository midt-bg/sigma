// Projection helpers between a useChat message and the dock's compact report chip (spec §1).
//
// A finished report arrives as a `tool-emit_report` part on the assistant message (contract §3); the
// chip is a projection of that report's title + one lead statistic.

import { count, date, money, pct } from '@sigma/shared';
import { EMIT_REPORT_PART } from '../assistant-contract/stream';
import { DEDUP_PART, type DedupData } from '../../../workers/assistant/dedup-stream';
import type { DedupLayer } from '../../../workers/assistant/dedup';
import type { CellFormat, EmitReportOutput, ResolvedReport } from './contract';

// Client-safe allowlist for the untrusted `layer` (dedup.ts itself is worker-only — it runs key
// derivation at module load, so we import DedupLayer type-only and keep the runtime set here). The
// `satisfies` lock fails the build if any entry stops being a valid layer; a NEW union member merely
// won't render its reuse affordance until added here (benign — falls back to regeneration).
const DEDUP_LAYERS = ['L0', 'L1', 'L2', 'L2.5', 'L3'] as const satisfies readonly DedupLayer[];

// Minimal shape we read from a useChat UIMessage part — avoids coupling to the SDK's full part typing
// (we only ever read `type`, `state`, `output`, and — for the dedup part — `data`).
interface MessagePartLike {
  type: string;
  state?: string;
  output?: unknown;
  data?: unknown;
}
interface MessageLike {
  parts?: MessagePartLike[];
}

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
 *
 * When the model retries emit_report after a validation failure, the message has multiple settled parts.
 * We return the LAST ok:true output so a successful retry is surfaced instead of the earlier failure.
 * Falls back to the last output of any kind so a persistent failure is still shown.
 */
export const reportOutputFromMessage = (message: MessageLike): EmitReportOutput | null => {
  let lastOk: EmitReportOutput | null = null;
  let lastAny: EmitReportOutput | null = null;
  for (const part of message.parts ?? []) {
    if (
      part.type === EMIT_REPORT_PART &&
      part.state === 'output-available' &&
      part.output != null &&
      isEmitReportOutput(part.output)
    ) {
      lastAny = part.output;
      if (part.output.ok) lastOk = part.output;
    }
  }
  return lastOk ?? lastAny;
};

/**
 * True when the assistant made ≥1 tool call this turn but produced NO emit_report part at all — i.e. the
 * turn ran out of tool steps (or otherwise stopped) before composing a report. The transcript pairs this
 * with "no visible prose" and a settled turn to show a graceful fallback instead of a blank turn. It does
 * NOT fire for a report failure (that surfaces its own ok:false affordance) — only for the missing-report
 * case. `tool-emit_report` is itself a `tool-` part, so its presence (in any state) suppresses this.
 */
export const isToolTurnWithoutReport = (message: MessageLike): boolean => {
  let sawTool = false;
  for (const part of message.parts ?? []) {
    const type = part.type ?? '';
    if (type === EMIT_REPORT_PART) return false;
    if (type.startsWith('tool-') || type === 'dynamic-tool') sawTool = true;
  }
  return sawTool;
};

// Narrow the untrusted `data` of a `data-dedup` part (it round-trips through localStorage, which is
// same-origin-writable) to the fields the reuse affordance reads before rendering from them.
const isDedupData = (value: unknown): value is DedupData => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.reportId === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.label === 'string' &&
    typeof v.layer === 'string' &&
    (DEDUP_LAYERS as readonly string[]).includes(v.layer)
  );
};

/**
 * The dedup hit carried by a message served from cache, or null. On an L0–L2.5 hit the route runs no
 * emit_report tool — it streams a single `data-dedup` part instead — so the transcript renders a "reuse
 * existing report" affordance from this, linking to the immutable report at /reports/:reportId (spec §3c).
 */
export const dedupHitFromMessage = (message: MessageLike): DedupData | null => {
  for (const part of message.parts ?? []) {
    if (part.type === DEDUP_PART && isDedupData(part.data)) return part.data;
  }
  return null;
};

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
