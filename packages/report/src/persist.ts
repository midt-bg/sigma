// Decoupled `StoredReport` builder + R2 persistence (#167A T1).
//
// Extracted from `apps/web/app/lib/assistant/agent.ts`'s chat-coupled `persistReport` (which took a
// `ToolContext` and derived everything from the live chat turn) so both the chat lane and the ETL
// weekly-digest producer can build/persist the identical `StoredReport` shape. `buildStoredReport` is
// PURE — no R2, no DB; callers resolve `freshness` themselves (`fetchFreshness` in the chat lane,
// `data_freshness`/`home_totals.as_of` in the ETL lane) and pass an already-random/deterministic `id`.

import {
  STORED_REPORT_SCHEMA_VERSION,
  type ProvenanceSource,
  type ReportVerification,
  type ResolvedReport,
  type SourceFreshness,
  type StoredReport,
} from './contract';
import type { QueryResult } from './report-schema';

export interface BuildStoredReportInput {
  id: string;
  /** ISO-8601 UTC. Defaults to `new Date().toISOString()` — pass explicitly for deterministic tests. */
  createdAt?: string;
  /** ISO-8601 UTC of an in-place re-issue (spec §10.4). Additive — omit on a first publish. */
  refreshedAt?: string;
  report: ResolvedReport;
  question: string;
  sources: ProvenanceSource[];
  snapshot: QueryResult[];
  freshness: SourceFreshness[];
  model: string;
  promptVersion: string;
  /** Role-④ verifier outcome, if the verifier ran. Additive — omit entirely to skip the field. */
  verification?: {
    status: ReportVerification['status'];
    strippedClaimIds: string[];
    uncertainClaimIds: string[];
    errors?: string[];
  };
}

/** Build a `StoredReport` from a resolved report + its provenance. Pure — performs no I/O. */
export function buildStoredReport(input: BuildStoredReportInput): StoredReport {
  const { verification } = input;
  return {
    schemaVersion: STORED_REPORT_SCHEMA_VERSION,
    id: input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.refreshedAt ? { refreshedAt: input.refreshedAt } : {}),
    report: input.report,
    provenance: {
      question: input.question,
      sources: input.sources,
      snapshot: input.snapshot,
      freshness: input.freshness,
      model: input.model,
      promptVersion: input.promptVersion,
      ...(verification
        ? {
            verification: {
              status: verification.status,
              strippedClaimIds: verification.strippedClaimIds,
              uncertainClaimIds: verification.uncertainClaimIds,
              // Diagnostic-only; server-side audit trail (report.tsx strips provenance before hydration).
              ...(verification.errors ? { errors: verification.errors } : {}),
            },
          }
        : {}),
    },
  };
}

export interface PersistReportOptions {
  /** Set `cacheControl: public, max-age=31536000, immutable` — the ETL producer's `weeks/{ISO}.json` artifacts. */
  immutable?: boolean;
  /** Extra R2 customMetadata (string→string) merged over the base `title`/`question`/`createdAt`. Lets a
   *  caller attach listing-facing fields it does NOT want to re-parse from the object body — e.g. the
   *  digest producer stamps `totalEur`/`monday`/`sunday` so the `/weeks` archive index needs no per-week
   *  fetch. The base keys win on collision (a caller cannot clobber `title`/`question`/`createdAt`). */
  customMetadata?: Record<string, string>;
}

/** Write a `StoredReport` to R2 at `key`. Caller decides the key convention (`report/{id}.json` for
 * chat, `weeks/{ISO}.json` for the digest producer) and swallows/logs failures per its own policy —
 * this function does not catch; it lets the bucket error propagate. */
export async function persistReport(
  bucket: R2Bucket,
  key: string,
  stored: StoredReport,
  opts?: PersistReportOptions,
): Promise<void> {
  await bucket.put(key, JSON.stringify(stored), {
    httpMetadata: {
      contentType: 'application/json',
      ...(opts?.immutable ? { cacheControl: 'public, max-age=31536000, immutable' } : {}),
    },
    customMetadata: {
      ...(opts?.customMetadata ?? {}),
      // Base keys last so a caller's extras can never clobber the canonical trio.
      title: stored.report.title,
      question: stored.provenance.question,
      createdAt: stored.createdAt,
    },
  });
}

/** Read + parse a `StoredReport` from R2. Returns `null` if the key is absent or the body isn't valid JSON. */
export async function readStoredReport(
  bucket: R2Bucket,
  key: string,
): Promise<StoredReport | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as StoredReport;
  } catch {
    return null;
  }
}
