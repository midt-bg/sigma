// Local TYPE mirror of the foundation's report contract. The canonical source is the server's Zod
// schema `~/lib/assistant/report-schema` — it is the `emit_report` tool's `parameters` (the model's
// output is validated against it) and is consumed by the /reports/:id renderer. The dock only needs the
// inferred TYPES, not the runtime validator, so this mirrors them 1:1 with the same names — at foundation
// merge, swap `./contract` for `~/lib/assistant/report-schema` and delete this file; the types match.
// (FormatHint stays dock-local — report-schema keeps it internal.)
// TODO(foundation-merge): replace with `import type { ReportArtifact, ReportBlockType, StoredReport } from '~/lib/assistant/report-schema'`.

export type FormatHint = 'money' | 'number' | 'percent' | 'date' | 'text';
export type EntityKind = 'authority' | 'company' | 'contract';

export interface TableColumn {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center' | 'num' | 'money';
  format?: FormatHint;
  // The renderer builds the entity href from `kind` + the value in row[field].
  link?: { kind: EntityKind; field: string };
}

// The closed block vocabulary (v1). Discriminated on `type`; values are already real, not refs.
export type ReportBlockType =
  | { type: 'text'; content: string }
  | { type: 'callout'; title?: string; content: string; variant?: 'info' | 'warning' }
  | {
      type: 'totals';
      label?: string;
      items: { label: string; value: string | number; format?: FormatHint }[];
    }
  | { type: 'facts'; label?: string; rows: { term: string; value: string; sub?: string }[] }
  | {
      type: 'table';
      caption?: string;
      columns: TableColumn[];
      rows: Record<string, string | number | null>[];
    }
  | {
      type: 'bar';
      label?: string;
      unit?: string;
      items: { label: string; value: number; key?: string }[];
    }
  | {
      type: 'flows';
      label?: string;
      edges: { from: string; to: string; valueEur: number; contracts?: number }[];
    }
  | {
      type: 'timeseries';
      label?: string;
      unit?: string;
      points?: { period: string; value: number }[];
      series?: { label: string; points: { period: string; value: number }[] }[];
    };

export interface FreshnessSource {
  source: 'admin' | 'ocds' | 'eop';
  label: string;
  asOf: string;
}

// The `emit_report` tool INPUT (args) — the report the model emits.
export interface ReportArtifact {
  title: string;
  lede?: string;
  scope?: string;
  methodology?: string;
  freshness?: FreshnessSource[];
  blocks: ReportBlockType[];
}

// The persisted artifact (server adds id + metadata); the /reports index reads it.
export interface StoredReport extends ReportArtifact {
  id: string;
  generatedAt: string;
  promptSummary?: string;
}

// The `emit_report` tool RESULT (what the dock receives as the part's `output`): a stored-report
// reference, or a server error (e.g. the artifact exceeded the R2 size cap). Defined inline in
// routes/assistant.chat.tsx, not in report-schema.
export type EmitReportResult = { id: string; title: string; url: string } | { error: string };
