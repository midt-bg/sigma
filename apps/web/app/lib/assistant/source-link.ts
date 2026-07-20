// source_link — deterministic, official deep links so a report can cite back to the source registry
// (spec §3). For a government tool a WRONG "official source" link is worse than none, so this only
// emits links whose URL pattern is grounded in the codebase:
//   - ЦАИС ЕОП procedure page — https://app.eop.bg/today/{eopTenderId} (see routes/contract.tsx)
//   - ЦАИС ЕОП open-data day files — via the verified eopSource helper (storage.eop.bg)
// Търговски регистър (BRRA) and the legacy АОП register are intentionally DEFERRED until their exact
// public deep-link patterns are confirmed — see the note below. Pure; unit-testable, no bindings.

import { eopSourceFiles, type EopSourceFile } from '../eopSource';

export const EOP_APP_BASE = 'https://app.eop.bg';

// eop_tender_id is a server-side value (tenders.eop_tender_id); still validate it as a safe path token
// so nothing can smuggle a path/protocol into the cited URL.
const EOP_TENDER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** ЦАИС ЕОП procedure page for a tender's `eop_tender_id`, or null if absent/unsafe. */
export function eopProcedureUrl(eopTenderId: string | null | undefined): string | null {
  const id = (eopTenderId ?? '').trim();
  if (!EOP_TENDER_ID_RE.test(id)) return null;
  return `${EOP_APP_BASE}/today/${id}`;
}

/** Direct links to the raw ЦАИС ЕОП open-data files for a publication day (reuses the verified helper). */
export function eopOpenDataUrls(publishedAt: string | null | undefined): EopSourceFile[] {
  return eopSourceFiles(publishedAt);
}

export interface SourceLink {
  label: string;
  url: string;
}

/**
 * Collect the official source links available for a contract-shaped reference. Only grounded links
 * are returned; absent inputs simply yield fewer links (never a fabricated one).
 */
export function sourceLinks(input: {
  eopTenderId?: string | null;
  publishedAt?: string | null;
}): SourceLink[] {
  const links: SourceLink[] = [];
  const proc = eopProcedureUrl(input.eopTenderId);
  if (proc) links.push({ label: 'Процедура в ЦАИС ЕОП', url: proc });
  for (const f of eopOpenDataUrls(input.publishedAt)) {
    links.push({ label: `Отворени данни — ${f.label}`, url: f.url });
  }
  return links;
}

// DEFERRED (do not ship guessed URLs): Търговски регистър (public.brra.bg / portal.registryagency.bg)
// deep links by ЕИК, and the legacy АОП register, need their exact public URL pattern confirmed
// against the live services before being emitted as "official" citations.
