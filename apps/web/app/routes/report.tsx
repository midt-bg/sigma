// /reports/:id — AI-generated report viewer (spec §D4).
//
// Loads an immutable StoredReport from R2 (written by Lane C4) and renders it with:
//  • The AI watermark (D5) — always visible, above the content.
//  • The report blocks (D1–D3) — via ReportBlockRenderer which enforces no-raw-HTML + safe links.
//  • The methodology + per-source freshness callout (D5, D6) — in a <details> at the bottom.
//
// Security posture:
//  • Cache-Control: no-store — the per-request CSP nonce emitted by entry.server.tsx must not be
//    frozen in a cache. This is the route-level guard; the worker layer must not override it.
//  • The global nonce-based CSP from entry.server.tsx is the primary HTML-injection defence.
//  • ReportBlockRenderer renders text/callout through MarkdownBlock (no raw HTML, http/https links).
//
// C4 dependency: the REPORTS R2 binding and the `report/<id>.json` key layout are owned by C4.
// Until C4 deploys, every /reports/:id request returns 404.

import type { Route } from './+types/report';
import { type StoredReport } from '~/lib/assistant-contract/report';
import { ReportBlockRenderer } from '~/components/ReportBlockRenderer';
import { ReportAiWatermark } from '~/components/ReportAiWatermark';
import { ReportToolbar } from '~/components/ReportToolbar';

// ── R2 fetch ────────────────────────────────────────────────────────────────

function isStoredReport(value: unknown): value is StoredReport {
  if (typeof value !== 'object' || value === null) return false;
  // Accept any schemaVersion >= 1 (a stable floor), NOT `>= STORED_REPORT_SCHEMA_VERSION`: StoredReports
  // are immutable in R2, so gating on the current code's version would 404 every already-stored v1 report
  // the moment that constant is bumped. Forward-compat is intentional — newer reports render best-effort
  // on older code — so the floor stays a literal 1. (STORED_REPORT_SCHEMA_VERSION marks what THIS code
  // writes, not the minimum it can read.)
  if (
    !('schemaVersion' in value) ||
    typeof value.schemaVersion !== 'number' ||
    (value.schemaVersion as number) < 1
  ) {
    return false;
  }
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('report' in value) || typeof value.report !== 'object' || value.report === null) {
    return false;
  }
  if (!Array.isArray((value.report as { blocks?: unknown }).blocks)) return false;
  if (!('provenance' in value) || typeof value.provenance !== 'object' || value.provenance === null)
    return false;
  return true;
}

async function loadReport(bucket: R2Bucket, id: string): Promise<StoredReport | null> {
  const obj = await bucket.get(`report/${id}.json`);
  if (!obj) return null;
  let raw: unknown;
  try {
    raw = await obj.json();
  } catch {
    return null;
  }
  return isStoredReport(raw) ? raw : null;
}

// ── Route exports ───────────────────────────────────────────────────────────

export function meta({ data }: Route.MetaArgs) {
  const title = data?.report.report.title;
  return [
    { title: title ? `${title} — СИГМА` : 'Справка — СИГМА' },
    { name: 'robots', content: 'noindex' },
  ];
}

/**
 * Defense-in-depth: set Cache-Control: no-store so the per-request nonce from entry.server.tsx
 * is never served from a frozen cache entry. The CSP itself is set globally by entry.server.tsx.
 */
export function headers() {
  return {
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const id = params.id?.trim();
  if (!id) throw new Response('Not Found', { status: 404 });

  const bucket = context.cloudflare.env.REPORTS;
  if (!bucket) {
    // C4 not yet deployed — report storage not available.
    throw new Response('Not Found', { status: 404 });
  }

  const stored = await loadReport(bucket, id);
  if (!stored) throw new Response('Not Found', { status: 404 });

  // Strip provenance (SQL, model, prompt version) before serializing to the client —
  // single-fetch sends the full loader return as hydration JSON regardless of what the
  // component reads, so sensitive fields must be omitted here, not just left unrendered.
  const { provenance: _omit, ...clientSafe } = stored;
  return { report: clientSafe };
}

// ── UI ───────────────────────────────────────────────────────────────────────

export default function ReportPage({ loaderData }: Route.ComponentProps) {
  const { report: stored } = loaderData;
  const { report } = stored;

  return (
    <main id="main" className="report-page">
      {/* D5: watermark — always the first visible element */}
      <ReportAiWatermark />

      <header className="report-page__header">
        <h1 className="report-page__title">{report.title}</h1>
        <p className="report-page__question">{report.question}</p>
      </header>

      <ReportToolbar report={report} />

      {/* D1–D3: block rendering (timeseries, markdown, CSP) */}
      <ReportBlockRenderer blocks={report.blocks} />
    </main>
  );
}
