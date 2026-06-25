// Projection helpers between a useChat message and the dock's transcript affordances (spec §1).
//
// A turn runs server-side tools (describe_schema, run_sql, …) and finishes with `emit_report`. Each tool
// surfaces as a `tool-<name>` part: while it runs we show a per-tool progress line; when `emit_report`
// settles, its RESULT (`{ id, title, url }`) gives the chip's title + „Отвори" href and its INPUT (the
// ReportArtifact) gives the lead statistic.

import { count, date, money, pct } from '@sigma/shared';
import type { FormatHint, ReportArtifact } from './contract';

// Minimal shape we read from a useChat tool UIMessage part (SDK v6): `type`, `state`, and the tool
// `input` (args) / `output` (result). Avoids coupling to the SDK's full part typing.
interface MessagePartLike {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
}
interface MessageLike {
  parts?: MessagePartLike[];
}

const EMIT_REPORT_PART = 'tool-emit_report';
const PENDING_STATES = new Set(['input-streaming', 'input-available']);

// Per-tool progress copy shown while a tool is in flight (mirrors the server's tool set).
const TOOL_LABELS: Record<string, string> = {
  'tool-describe_schema': 'Чете схемата…',
  'tool-run_sql': 'Изпълнява заявка…',
  'tool-search_entities': 'Търси…',
  'tool-get_company': 'Зарежда компания…',
  'tool-get_authority': 'Зарежда институция…',
  'tool-get_contract': 'Зарежда договор…',
  'tool-emit_report': 'Подготвям справка…',
};

export interface ReportChipData {
  title: string;
  leadStat: string | null;
  href: string;
}

export interface MessageReportView {
  /** A finished report → render the chip. */
  chip: ReportChipData | null;
  /** emit_report returned an error (e.g. report too large) → render the failure line. */
  error: string | null;
  /** A tool is in flight → render this progress line. */
  pendingLabel: string | null;
}

// The emit_report RESULT crosses an untrusted boundary; narrow it rather than cast.
const isReportRef = (value: unknown): value is { id: string; title: string; url: string } =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'title' in value &&
  typeof value.title === 'string' &&
  'url' in value &&
  typeof value.url === 'string';

const isErrorResult = (value: unknown): value is { error: string } =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof value.error === 'string';

// The emit_report INPUT — we only read `blocks` for the lead stat, so that is all we validate.
const isReportArtifact = (value: unknown): value is ReportArtifact =>
  typeof value === 'object' && value !== null && 'blocks' in value && Array.isArray(value.blocks);

const toNumber = (value: string | number | null): number | null => {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Mirrors the foundation's report renderer formatting so the chip's lead stat reads like the rest of the
// site (money in EUR, percent as a 0..1 ratio, blank as an em-dash).
const formatByHint = (value: string | number | null, format: FormatHint): string => {
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
      // Typed string | number, but it crosses an untrusted tool boundary; guard against a non-primitive
      // slipping through (String({}) → '[object Object]') by showing the em-dash instead.
      if (typeof value === 'string') return value === '' ? '—' : value;
      if (typeof value === 'number') return String(value);
      return '—';
  }
};

// The first totals/facts value is the most informative one-line stat; a report with neither (e.g. a bare
// table or chart) shows just the title.
export const leadStat = (artifact: ReportArtifact): string | null => {
  for (const block of artifact.blocks) {
    if (block.type === 'totals' && block.items[0]) {
      const item = block.items[0];
      return `${item.label}: ${formatByHint(item.value, item.format ?? 'text')}`;
    }
    if (block.type === 'facts' && block.rows[0]) {
      const row = block.rows[0];
      return `${row.term}: ${formatByHint(row.value, 'text')}`;
    }
  }
  return null;
};

/**
 * Single pass over a message's tool parts → the transcript's three (mutually exclusive in practice)
 * affordances: a finished report chip, an emit_report error line, or a per-tool progress line.
 */
export const reportViewFromMessage = (message: MessageLike): MessageReportView => {
  const view: MessageReportView = { chip: null, error: null, pendingLabel: null };
  for (const part of message.parts ?? []) {
    if (!part.type.startsWith('tool-')) continue;
    if (part.type === EMIT_REPORT_PART && part.state === 'output-available') {
      if (isReportRef(part.output)) {
        const artifact = isReportArtifact(part.input) ? part.input : null;
        view.chip = {
          title: part.output.title,
          href: part.output.url || `/reports/${part.output.id}`,
          leadStat: artifact ? leadStat(artifact) : null,
        };
      } else if (isErrorResult(part.output)) {
        view.error = part.output.error;
      }
    } else if (PENDING_STATES.has(part.state ?? '')) {
      view.pendingLabel = TOOL_LABELS[part.type] ?? '…';
    }
  }
  return view;
};
