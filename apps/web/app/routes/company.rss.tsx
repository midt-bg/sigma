import {
  bidderIdFromSlug,
  companySlug,
  getCompanyHead,
  listRecentEntityContracts,
} from '@sigma/db';
import type { Route } from './+types/company.rss';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';
import { contractRssItem, rssFeed } from '../lib/feed';
import { withDbRetry } from '../lib/retry';

// Resource route: RSS 2.0 feed of a company's newest contracts (/companies/:eik.rss) - the
// no-account way to follow an entity (docs/api.md). X-Robots-Tag keeps feeds out of search indexes
// (profile pages carry the indexable content; some company profiles are deliberately noindex, #173).
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const slug = (params.eik ?? '').replace(/\.rss$/, '');
  if (!slug.trim()) return withDataSource(new Response('Not Found', { status: 404 }));
  const bidderId = bidderIdFromSlug(slug);
  if (!bidderId) return withDataSource(new Response('Not Found', { status: 404 }));
  // Build the self/site links from the CANONICAL slug (re-derived from the resolved bidder id), not the
  // raw request param, so a resolvable-but-non-canonical request (e.g. a name-keyed slug with different
  // base64 padding) still emits the same URLs as the HTML profile (review ydimitrof).
  const canonicalSlug = companySlug(bidderId);
  const db = context.cloudflare.env.DB;
  const { origin } = new URL(request.url);
  return withDbRetry(async () => {
    const head = await getCompanyHead(db, bidderId);
    if (!head) return withDataSource(new Response('Not Found', { status: 404 }));
    const contracts = await listRecentEntityContracts(db, { kind: 'company', bidderId });
    const xml = rssFeed({
      title: `${head.name} - нови договори - СИГМА`,
      description: `Най-новите договори за обществени поръчки, спечелени от ${head.name}.`,
      siteLink: `${origin}/companies/${canonicalSlug}`,
      selfLink: `${origin}/companies/${canonicalSlug}.rss`,
      items: contracts.map((c) => contractRssItem(c, 'authority', origin)),
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
