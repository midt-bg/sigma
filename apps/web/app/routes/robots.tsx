import type { Route } from './+types/robots';

export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  // `/*/search` covers the per-locale mirrors (e.g. /en/search) so result pages aren't crawled in any
  // locale; `/search` keeps the bg path covered for crawlers that don't honour the wildcard.
  const body = `User-agent: *\nAllow: /\nDisallow: /search\nDisallow: /*/search\nDisallow: /*.csv\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
