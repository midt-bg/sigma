import type { Route } from './+types/sitemap-pages';
import { withDataSource } from '../lib/dataSource';

const PAGES = [
  '/',
  '/companies',
  '/authorities',
  '/contracts',
  '/flows',
  '/methodology',
  '/privacy',
  '/impressum',
  '/accessibility',
];

export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    PAGES.map((p) => `<url><loc>${origin}${p}</loc></url>\n`).join('') +
    `</urlset>\n`;
  return withDataSource(
    new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    }),
  );
}
