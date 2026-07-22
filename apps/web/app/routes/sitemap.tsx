import { contractSitemapPages, getDb } from '@sigma/db';
import type { Route } from './+types/sitemap';
import { withDataSource } from '../lib/dataSource';

// Sitemap index: the static-pages sitemap + per-type sitemaps (contracts paginated under 50k URLs).
export async function loader({ request, context }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const pages = await contractSitemapPages(getDb(context.cloudflare.env));
  const maps = [
    `${origin}/sitemap-pages.xml`,
    `${origin}/sitemap-authorities.xml`,
    `${origin}/sitemap-companies.xml`,
    ...Array.from({ length: pages }, (_, i) => `${origin}/sitemap-contracts.xml?p=${i + 1}`),
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    maps.map((m) => `<sitemap><loc>${m.replace(/&/g, '&amp;')}</loc></sitemap>\n`).join('') +
    `</sitemapindex>\n`;
  return withDataSource(
    new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    }),
  );
}
