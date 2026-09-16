import type { Route } from './+types/robots';

export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const body = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
