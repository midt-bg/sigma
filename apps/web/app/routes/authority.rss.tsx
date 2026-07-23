import {
  authorityIdFromSlug,
  authoritySlug,
  getAuthorityHead,
  listRecentEntityContracts,
} from '@sigma/db';
import type { Route } from './+types/authority.rss';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';
import { contractRssItem, rssFeed } from '../lib/feed';
import { withDbRetry } from '../lib/retry';

// Resource route: RSS 2.0 feed of an authority's newest contracts (/authorities/:eik.rss) - the
// no-account way to follow an entity (docs/api.md). X-Robots-Tag keeps feeds out of search indexes
// (profile pages carry the indexable content; some company profiles are deliberately noindex, #173).
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const eik = (params.eik ?? '').replace(/\.rss$/, '');
  if (!eik.trim()) return withDataSource(new Response('Not Found', { status: 404 }));
  const db = context.cloudflare.env.DB;
  // No early slug-validity 404 like company.rss (which short-circuits on bidderIdFromSlug === null):
  // authorityIdFromSlug is total (authorities are always ЕИК-keyed, no fallible decode), and the raw
  // ЕИК is not format-constrained in the pipeline, so validating here could reject a real profile and
  // would diverge from the HTML authority route. An unknown slug just yields getAuthorityHead === null
  // → 404 below, at the cost of one indexed no-row lookup (review ydimitrof).
  const authorityId = authorityIdFromSlug(eik);
  // Build the self/site links from the CANONICAL slug (derived from the resolved id), not the raw
  // request param, so a resolvable-but-non-canonical request still emits the same URLs as the HTML
  // profile (review ydimitrof).
  const canonicalEik = authoritySlug(authorityId);
  const { origin } = new URL(request.url);
  return withDbRetry(async () => {
    const head = await getAuthorityHead(db, authorityId);
    if (!head) return withDataSource(new Response('Not Found', { status: 404 }));
    const contracts = await listRecentEntityContracts(db, { kind: 'authority', authorityId });
    const xml = rssFeed({
      title: `${head.name} - нови договори - СИГМА`,
      description: `Най-новите договори за обществени поръчки, възложени от ${head.name}.`,
      siteLink: `${origin}/authorities/${canonicalEik}`,
      selfLink: `${origin}/authorities/${canonicalEik}.rss`,
      items: contracts.map((c) => contractRssItem(c, 'bidder', origin)),
    });
    return withDataSource(
      new Response(xml, {
        headers: {
          'Content-Type': 'application/rss+xml; charset=utf-8',
          'Cache-Control': publicCache(3600),
          'X-Robots-Tag': 'noindex',
        },
      }),
    );
  });
}
