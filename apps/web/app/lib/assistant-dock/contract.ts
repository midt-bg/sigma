// Local mirror of the report contract the dock consumes. The canonical schema is the server foundation's
// `~/lib/assistant/report-schema` (not yet on this branch); the v1 block model it encodes is documented
// in docs/spec/ai-assistant.md ("Block речник (v1)").
//
// The dock is built against this mirror so the branch compiles and tests without that foundation present.
// On foundation merge to `main`, delete this file and import the same types from the schema module above
// (the source of truth).
// TODO(foundation-merge): replace this module with `import type { ... } from '~/lib/assistant/report-schema'`.

export type CellFormat = 'money' | 'number' | 'percent' | 'date' | 'text';
export type EntityKind = 'company' | 'authority' | 'contract';

export interface ResolvedColumn {
  key: string;
  header: string;
  align?: 'left' | 'right';
  format: CellFormat;
  link?: { kind: EntityKind; idCol: string };
}

export interface ResolvedRow {
  cells: (string | number | null)[];
  // Raw entity id per column for columns that declare a `link` (else null), aligned to `columns`.
  links?: (string | null)[];
}

// The resolved (server-bound) blocks the renderer/chip consume — values are already real, not refs.
export type ResolvedBlock =
  | { type: 'text'; md: string }
  | { type: 'callout'; title: string; md: string }
  | {
      type: 'totals';
      items: { label: string; value: string | number | null; format: CellFormat }[];
    }
  | { type: 'facts'; items: { term: string; value: string | number | null; sub?: string }[] }
  | { type: 'table'; columns: ResolvedColumn[]; rows: ResolvedRow[] }
  // `bar` carries an optional `key` per spec §4 (Block речник: `[{label, value, key?}]`) — the renderer
  // uses it for palette determinism across stacked segments.
  | { type: 'bar'; points: { label: string | number | null; value: number; key?: string }[] }
  | { type: 'flows'; edges: { from: string; to: string; valueEur: number }[] }
  // `timeseries` is single- OR multi-series per spec §4 (`[{period, value}]` (+ optional multi-series)).
  | {
      type: 'timeseries';
      points?: { period: string | number | null; value: number }[];
      series?: { label: string; points: { period: string | number | null; value: number }[] }[];
    };

export interface ResolvedReport {
  title: string;
  question: string;
  blocks: ResolvedBlock[];
  watermark: 'ai-generated';
}

// The `emit_report` tool part `output` shape (contract §3): a finished report or validation errors.
// `storedId` is present when Lane C4 successfully persisted the report to R2 — the dock uses it
// to construct the `/reports/:id` link on the ReportChip ("Отвори" button).
export type EmitReportOutput =
  | { ok: true; report: ResolvedReport; storedId?: string }
  | { ok: false; errors: string[] };
