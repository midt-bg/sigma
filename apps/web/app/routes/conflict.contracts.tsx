import { data } from 'react-router';
import { getLinkContracts, personIdFromSlug, getDb } from '@sigma/db';
import type { Route } from './+types/conflict.contracts';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';

// Resource route (loader-only): one published link's contracts, each flagged in/out the declared-stake
// window. Keyed on the URL-safe :scope/:slug/:eik and reconstructed into the link_key server-side, so the raw
// '|'/':' key never hits the URL. :scope is a PATH segment (self | family), not a query param, so it is always
// part of the cache key — a self-link and a family-link list for the same slug+eik can never collapse to one
// entry. Lives under /conflicts/ so the CONFLICTS_RATE_LIMITER already throttles enumeration.
//
// STATUS (niki #312 MEDIUM 6): since #287 the person/company pages load contracts EAGERLY (server-side, ЕИК-
// deduped in `loadLinkContracts`), so this endpoint has no in-app consumer today. It is retained DELIBERATELY,
// not dead code: it is the single-link, gated (`getLinkContracts`) JSON resource — the ready lazy „valve" for a
// future large-page fallback (the HIGH 2 per-page cap) and a stable public per-link endpoint. Its 404 guards
// and self/family key isolation stay under test in `conflicts.loaders.test.ts`. Retire it only together with
// those guards if a decision is made to drop the public endpoint.
export async function loader({ params, context }: Route.LoaderArgs) {
  const personId = personIdFromSlug(params.slug ?? '');
  const eik = params.eik ?? '';
  const scope = params.scope ?? '';
  // eik is a raw path segment slotted into link_key with '|' delimiters. %7C decodes to '|' before we see
  // it, so an unvalidated eik like '123|family' would build the FAMILY key for eik=123 under scope=self —
  // collapsing the self- and family-link lists (a libel leak). A БГ ЕИК is always numeric, so require digits.
  if (!personId || !/^\d+$/.test(eik) || (scope !== 'self' && scope !== 'family')) {
    throw new Response('Not Found', { status: 404 });
  }
  const linkKey = scope === 'family' ? `${personId}|${eik}|family` : `${personId}|${eik}`;
  const contracts = await withDbRetry(() =>
    getLinkContracts(getDb(context.cloudflare.env), linkKey),
  );
  // Only cache once there is data — an empty read just after a (re)ship should not be pinned for an hour
  // (mirrors the leaderboard loader). getLinkContracts returns [] for any non-surfaced/unknown key.
  // noindex is applied at the worker for every /conflicts response (HTML + this .data twin alike).
  return data(
    { linkKey, contracts },
    { headers: { 'Cache-Control': contracts.length ? publicCache(3600) : 'no-store' } },
  );
}
