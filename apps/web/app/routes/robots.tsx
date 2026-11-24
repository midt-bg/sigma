import type { Route } from './+types/robots';
import { CRAWL_FILTERED_PATHS } from '../lib/canonical-path';
import { isIndexedHost } from '../lib/indexing';

// Limit crawl volume on query variants of public lists and explorers. Match their canonical paths
// followed by the query delimiter so detail pages and paged sitemaps remain crawlable.
// Crawlers must be able to fetch person profiles, conflicts, search and technical responses to
// see their existing noindex directives.
const PRODUCTION_RULES = [
  'User-agent: *',
  'Allow: /',
  ...CRAWL_FILTERED_PATHS.map((path) => `Disallow: ${path}?`),
];

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Outside the production site (stage, dev, a workers.dev twin) the whole host is off limits.
  const body = isIndexedHost(url)
    ? `${PRODUCTION_RULES.join('\n')}\nSitemap: ${url.origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
