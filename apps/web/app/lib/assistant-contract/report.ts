// Assistant contracts #1 + #2 — the typed seams between nedda76's backend (#80) and our lanes.
//
// #1  Block-spec (backend → renderer): the renderer draws a `ResolvedReport`. SOURCE OF TRUTH is
//     #80's `report-schema.ts` (model emits refs → `bindReport()` re-binds real values → resolved
//     shape, spec §4). We RE-EXPORT it so the renderer/persist lanes import ONE type, never a copy.
// #2  R2 stored object (persist → renderer): NEW (persist lane). `StoredReport` wraps the resolved
//     report with provenance so `/reports/:id` renders LLM-free + D1-free from one immutable object
//     (spec §5) and every figure stays auditable.
//
// Dependency direction: this module MAY import from `../assistant`; `../assistant` must NEVER import
// from here. (Design rationale: spec §4/§5/§7 + the §9 hardening review in PR #79.)
// See ./README.md.

export type {
  ResolvedReport,
  ResolvedBlock,
  QueryResult,
  CellFormat,
  EntityKind,
  EmitTableColumn,
} from '../assistant/report-schema';

import type { ResolvedReport, QueryResult } from '../assistant/report-schema';

// Renderer obligation: `ResolvedReport`'s text/callout `md` is pre-sanitized by `bindReport`
// (sanitizeProse strips raw HTML, spec §7), but the renderer MUST still render markdown with
// raw-HTML passthrough DISABLED — the sanitization guarantee is lost if the markdown renderer
// re-introduces an HTML sink. Entity links are built by the renderer from `{kind,id}` refs
// (`EmitTableColumn.link`); the model never supplies a URL.

export type FreshnessSource = 'admin' | 'ocds' | 'eop';
export interface SourceFreshness {
  source: FreshnessSource;
  asOf: string; // ISO-8601 date (date-time for the live eop_fetch case)
}

// One provenance entry per result set in the snapshot, linked by `handle`. Not every result comes
// from SQL: curated tools (`get_company`, `search_entities`) and `eop_fetch` produce snapshot rows
// with NO SQL — so `sql` is optional and `tool` names the path. "View the query" shows `sql` when
// present, otherwise names the tool. (Closes the run_sql-only gap.)
export interface ProvenanceSource {
  handle: string; // matches a QueryResult.handle in `snapshot`
  tool: string; // 'run_sql' | 'search_entities' | 'get_company' | 'eop_fetch' | …
  sql?: string; // present only for run_sql
}

// Role-④ (LLM Verifier) audit trail — what the risk-scaled verification pass decided for this report
// (spec addendum §1/§2 defense 5). 'skipped' = deterministic gate found no ranking/risk claims (no LLM
// call); 'verified' = verdicts applied; 'error' = the verifier call failed and the fail-closed strip
// removed all extracted prose claims except the structural „Как е изчислено" methodology callout
// (guardrail D — kept + flagged). Claim ids ("C0"…) are the verifier's stable numbering: title
// first, then text/callout blocks in report order (see ../assistant/verifier.ts extractClaims).
export type ReportVerificationStatus = 'skipped' | 'verified' | 'error';
export interface ReportVerification {
  status: ReportVerificationStatus;
  strippedClaimIds: string[]; // prose blocks removed from the published report
  uncertainClaimIds: string[]; // kept-but-flagged (uncertain verdicts + an unsupported title/methodology callout)
  errors?: string[]; // present only on status 'error' — why the pass fail-closed (server-side audit; stripped from the client payload)
}

export interface ReportProvenance {
  question: string; // the asked question (also shown on the report — watermark, spec §4/§7)
  sources: ProvenanceSource[]; // how each snapshot result set was produced (one per handle)
  snapshot: QueryResult[]; // the bounded result sets, embedded so the view never re-queries D1 (§4/§5)
  freshness: SourceFreshness[]; // per-source as-of; a report mixing sources shows each
  model: string; // e.g. 'bggpt-gemma-3-27b-fp8'
  promptVersion: string; // system-prompt / describe-schema version, for regression tracing
  // ADDITIVE (schemaVersion stays 1): absent on reports persisted before the verifier existed.
  verification?: ReportVerification;
  // (open) `corpusVersion?: string` — a stronger reproducibility anchor than freshness dates; see README.
}

// Embedded in every stored report so v1/v2/… all render forever. The WRITER pins the literal; the
// READER (/reports/:id) must switch on `schemaVersion`, keep old branches forever, and treat an
// unknown (future) version as best-effort render, not a hard failure. Bump only on a breaking change.
export const STORED_REPORT_SCHEMA_VERSION = 1 as const;

export interface StoredReport {
  schemaVersion: typeof STORED_REPORT_SCHEMA_VERSION;
  id: string; // random, unguessable — do not treat as a privacy boundary; /reports enumerates all IDs
  createdAt: string; // ISO-8601 UTC
  report: ResolvedReport; // contract #1 — renderable content (render md with raw-HTML disabled)
  provenance: ReportProvenance; // contract #2 — provenance the renderer also surfaces
}
