import type { Route } from './+types/robots';

export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  // /reports/:id are noindex per-route already; also disallow at site level (they may hold personal
  // data). /*.data is React Router's single-fetch payload for any route — keep it out of the index.
  const body = `User-agent: *\nAllow: /\nDisallow: /search\nDisallow: /reports\nDisallow: /*.csv\nDisallow: /*.data\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
