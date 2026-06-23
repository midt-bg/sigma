import type { Route } from './+types/sitemap-pages';
import { withDataSource } from '../lib/dataSource';

type Page = { loc: string; changefreq?: string; priority?: string };

// Editorial pages first, then legal/compliance pages. Legal pages are deprioritised in the
// sitemap so crawlers don't spend budget on them — they exist for compliance, not discovery.
const PAGES: Page[] = [
  { loc: '/' },
  { loc: '/companies' },
  { loc: '/authorities' },
  { loc: '/contracts' },
  { loc: '/flows' },
  { loc: '/network' },
  { loc: '/trends' },
  { loc: '/map' },
  { loc: '/methodology' },
  { loc: '/privacy', changefreq: 'yearly', priority: '0.1' },
  { loc: '/impressum', changefreq: 'yearly', priority: '0.1' },
  { loc: '/accessibility', changefreq: 'yearly', priority: '0.1' },
];

// Escape XML special chars before interpolating. PAGES is hardcoded today, but the helper sits on
// the path that any future dynamic source (CMS-driven pages, generated slugs) would also flow
// through — keep it safe by default rather than relying on every caller to remember.
function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );
}

function entry(origin: string, p: Page): string {
  const parts = [`<loc>${xmlEscape(`${origin}${p.loc}`)}</loc>`];
  if (p.changefreq) parts.push(`<changefreq>${xmlEscape(p.changefreq)}</changefreq>`);
  if (p.priority) parts.push(`<priority>${xmlEscape(p.priority)}</priority>`);
  return `<url>${parts.join('')}</url>\n`;
}

export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    PAGES.map((p) => entry(origin, p)).join('') +
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
