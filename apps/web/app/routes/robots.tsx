import type { Route } from './+types/robots';
import { isIndexedHost } from '../lib/indexing';

// What crawlers are asked to leave alone on the production site. A search index needs the pages of the
// things themselves — a company, an authority, a contract — and those are all in the sitemaps. Everything
// below is the same data in another cut, and each cut is a page nobody has rendered before, so crawling
// them costs the database a full query apiece for nothing an index can use:
//   • any address with a query — a list filtered, sorted or paged; a search;
//   • the exports and the machine twins of pages (.csv, .data, a contract's .json).
// `Allow` for the paged contract sitemap is the longer rule, so it wins over the query rule.
const PRODUCTION_RULES = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /*?',
  'Allow: /sitemap-contracts.xml?',
  'Disallow: /search',
  'Disallow: /*.csv',
  'Disallow: /*.data',
  'Disallow: /contracts/*.json',
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
