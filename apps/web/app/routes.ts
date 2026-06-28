import {
  type RouteConfig,
  type RouteConfigEntry,
  index,
  route,
  prefix,
} from '@react-router/dev/routes';

// User-facing HTML pages. Mounted twice: once unprefixed (Bulgarian, the default) and once under
// `/en` (English). The same route modules back both locales — the active locale is read from the URL
// prefix (see app/i18n/locale.ts), so no per-locale module duplication is needed. The English branch
// gets explicit, namespaced route ids so the duplicated file paths don't collide.
function htmlRoutes(idNs?: string): RouteConfigEntry[] {
  const r = (path: string, file: string, name: string) =>
    idNs ? route(path, file, { id: idNs + name }) : route(path, file);
  const i = (file: string, name: string) => (idNs ? index(file, { id: idNs + name }) : index(file));
  return [
    i('routes/home.tsx', 'home'),
    r('search', 'routes/search.tsx', 'search'),
    r('flows', 'routes/flows.tsx', 'flows'),
    r('network', 'routes/network.tsx', 'network'),
    r('trends', 'routes/trends.tsx', 'trends'),
    r('map', 'routes/map.tsx', 'map'),
    r('competition', 'routes/competition.tsx', 'competition'),
    r('analytics', 'routes/analytics.tsx', 'analytics'),
    r('companies', 'routes/companies.tsx', 'companies'),
    r('companies/:eik', 'routes/company.tsx', 'company'),
    r('authorities', 'routes/authorities.tsx', 'authorities'),
    r('authorities/:eik', 'routes/authority.tsx', 'authority'),
    r('contracts', 'routes/contracts.tsx', 'contracts'),
    r('contracts/:id', 'routes/contract.tsx', 'contract'),
    r('methodology', 'routes/methodology.tsx', 'methodology'),
    r('accessibility', 'routes/accessibility.tsx', 'accessibility'),
    r('privacy', 'routes/privacy.tsx', 'privacy'),
    r('impressum', 'routes/impressum.tsx', 'impressum'),
  ];
}

// Machine endpoints (CSV / JSON / suggest / robots / sitemaps). Single-URL, Bulgarian-data — no locale
// variants: the payload is raw data, not translated interface, so an `/en` copy would just duplicate bytes.
const endpointRoutes: RouteConfigEntry[] = [
  route('search/suggest', 'routes/search.suggest.tsx'),
  route('assistant/chat', 'routes/assistant.chat.tsx'),
  route('companies.csv', 'routes/companies.csv.tsx'),
  route('authorities.csv', 'routes/authorities.csv.tsx'),
  route('contracts.csv', 'routes/contracts.csv.tsx'),
  route('contracts/:id.json', 'routes/contract.json.tsx'),
  route('robots.txt', 'routes/robots.tsx'),
  route('sitemap.xml', 'routes/sitemap.tsx'),
  route('sitemap-pages.xml', 'routes/sitemap-pages.tsx'),
  route('sitemap-authorities.xml', 'routes/sitemap-authorities.tsx'),
  route('sitemap-companies.xml', 'routes/sitemap-companies.tsx'),
  route('sitemap-contracts.xml', 'routes/sitemap-contracts.tsx'),
];

export default [
  ...htmlRoutes(),
  ...prefix('en', htmlRoutes('en/')),
  ...endpointRoutes,
] satisfies RouteConfig;
