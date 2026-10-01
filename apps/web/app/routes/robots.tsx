import type { Route } from './+types/robots';
import { isIndexedHost } from '../lib/indexing';

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Outside the production site (stage, dev, a workers.dev twin) the whole host is off limits.
  const body = isIndexedHost(url)
    ? `User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
