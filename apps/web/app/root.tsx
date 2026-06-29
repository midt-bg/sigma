import { useEffect, useRef } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigation,
  useNavigationType,
  useRouteLoaderData,
} from 'react-router';

import type { Route } from './+types/root';
import { useNonce } from './nonce';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { AccessibilityWidget } from './components/AccessibilityWidget';
import { PageHeader } from './components/PageHeader';
import { getCoverageMeta } from './lib/coverage';
import { withDbRetry } from './lib/retry';
import stylesheet from './app.css?url';
import { Link } from './i18n/Link';
import { LocaleProvider, useTranslation } from './i18n/context';
import {
  getLocale,
  localizePath,
  swapLocalePath,
  HTML_LANG,
  OG_LOCALE,
  LOCALES,
  type Locale,
} from './i18n/locale';
import { makeT } from './i18n/t';

// The editorial design uses a system serif/mono/sans stack (see app.css @theme) — no webfont request.
// Brand favicons (white „С“ on the deep-red tile) live in /public; declare them so the head is explicit.
export const links: Route.LinksFunction = () => [
  // Link the global stylesheet explicitly (instead of a side-effect import) so it is a real
  // <link> in the document head in dev too, not injected by JS after first paint - which avoids
  // a flash of unstyled content on a full reload. In production both paths emit the same <link>.
  { rel: 'stylesheet', href: stylesheet },
  { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
  { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
  { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
  { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
  { rel: 'stylesheet', href: '/assets/accessibility/accessibility.css' },
];

// One cheap read for the chrome: coverage and refresh metadata shown in the footer on every page.
export async function loader({ context, request }: Route.LoaderArgs) {
  // Canonicalise away a trailing slash so `/companies/` (which otherwise silently renders the list
  // and triggers a hydration mismatch) becomes `/companies`. Root loader runs for every route.
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    throw redirect(url.pathname.replace(/\/+$/, '') + url.search, 301);
  }
  // Wrapped like the leaf loaders: this chrome read runs on every route, so a transient D1 fault
  // here would 500 the whole page (incl. the entity pages this PR targets) without the retry.
  const coverage = await withDbRetry(() => getCoverageMeta(context.cloudflare.env.DB));
  return { ...coverage, origin: url.origin, locale: getLocale(request) };
}

// Scroll-restoration key for list pages. Filters and sort live in the query string under a stable
// pathname, so keying on pathname alone preserves the visitor's scroll position when they change a
// filter or sort instead of jumping to the top (issue #13). Pagination is the deliberate exception:
// Prev/Next carry a keyset `cursor` (which a filter or sort change resets), so a URL with a cursor
// gets its own key and lands at the top — the conventional paging behaviour.
function scrollKey(location: { pathname: string; search: string }): string {
  const cursor = new URLSearchParams(location.search).get('cursor');
  return cursor ? `${location.pathname}?cursor=${cursor}` : location.pathname;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useNonce();
  const location = useLocation();
  // Locale + origin come from the root loader so SSR and hydration agree; fall back to the URL prefix
  // for the error path, where root loader data may be absent. Derived ONCE here and handed down through
  // LocaleProvider, so App and ErrorBoundary (both rendered as `children`) share one memoized translator.
  const rootData = useRouteLoaderData('root') as { origin?: string; locale?: Locale } | undefined;
  const locale = rootData?.locale ?? getLocale(location.pathname);
  const t = makeT(locale);
  const origin = rootData?.origin;
  const imageUrl = origin ? `${origin}/og.png` : undefined;
  // Localised JSON-LD: language + description follow the active locale; the brand name and its
  // expansion stay as the registered (Bulgarian) proper noun. Search action targets the locale path.
  const schemaOrg = origin
    ? JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            '@id': `${origin}/#organization`,
            name: 'СИГМА',
            alternateName: 'Система за Интегриран Граждански Мониторинг и Анализ',
            url: origin,
            logo: { '@type': 'ImageObject', url: `${origin}/logo.svg` },
          },
          {
            '@type': 'WebSite',
            '@id': `${origin}/#website`,
            url: origin,
            name: 'СИГМА',
            description: t('og.siteDescription'),
            inLanguage: HTML_LANG[locale],
            publisher: { '@id': `${origin}/#organization` },
            potentialAction: {
              '@type': 'SearchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: `${origin}${localizePath('/search', locale)}?q={search_term_string}`,
              },
              'query-input': 'required name=search_term_string',
            },
          },
        ],
      })
    : null;
  return (
    <html lang={HTML_LANG[locale]}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="СИГМА" />
        <meta property="og:locale" content={OG_LOCALE[locale]} />
        {LOCALES.filter((loc) => loc !== locale).map((loc) => (
          <meta key={loc} property="og:locale:alternate" content={OG_LOCALE[loc]} />
        ))}
        {imageUrl && (
          <>
            <meta property="og:image" content={imageUrl} />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            <meta property="og:image:alt" content={t('og.imageAlt')} />
            <meta property="og:image:type" content="image/png" />
          </>
        )}
        <meta name="twitter:card" content="summary_large_image" />
        {imageUrl && <meta name="twitter:image" content={imageUrl} />}
        <Meta />
        <Links />
        {schemaOrg && (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: schemaOrg }} />
        )}
        <script src="/assets/accessibility/accessibility.js" defer />
      </head>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
        <ScrollRestoration nonce={nonce} getKey={scrollKey} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

// Thin top progress bar so cross-route navigation doesn't feel dead on slow networks.
// `useNavigation().state` is 'idle' on the server and the first client render, so the
// initial markup matches SSR — the bar only appears once a client-side transition starts.
function RouteProgress() {
  const busy = useNavigation().state !== 'idle';
  // States live in CSS (.route-progress[data-busy]), so no inline style is needed — that is the
  // point of the style-src CSP tightening. Reduced motion is honoured by the global
  // `@media (prefers-reduced-motion: reduce)` rule in app.css, which now reaches this element.
  return <div className="route-progress" aria-hidden="true" data-busy={busy} />;
}

export default function App({ loaderData }: Route.ComponentProps) {
  // After a client-side navigation, move focus to the main region so keyboard and
  // screen-reader users aren't stranded on <body> mid-page (and the skip link stays
  // reachable). Skip the first run so SSR/hydration and the initial load are untouched.
  // Also skip when only search params changed (filter or sort update within the same
  // page) — clicking a filter checkbox should not yank the user back to the top.
  const location = useLocation();
  const navigationType = useNavigationType();
  const firstRender = useRef(true);
  const prevPathname = useRef(location.pathname);
  useEffect(() => {
    const isFirst = firstRender.current;
    firstRender.current = false;
    const prevPath = prevPathname.current;
    prevPathname.current = location.pathname;
    if (isFirst) return;
    if (location.pathname === prevPath) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('main h1') ?? document.getElementById('main');
      if (el) {
        el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: navigationType === 'POP' });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.key, navigationType]);

  const t = useTranslation();
  const { origin } = loaderData;
  // Canonical / og:url / hreflang are keyed on the PATH ONLY — the query string is deliberately
  // dropped so filtered, sorted or utm-tagged variants of a list page
  // (`/contracts?year=2024&sort=value-desc`) all consolidate to one indexable URL per locale instead
  // of each becoming separately self-canonical. (The language switcher still preserves the query for
  // UX — that's navigation, not an SEO signal.)
  return (
    <>
      <link rel="canonical" href={`${origin}${location.pathname}`} />
      <meta property="og:url" content={`${origin}${location.pathname}`} />
      {LOCALES.map((loc) => (
        <link
          key={loc}
          rel="alternate"
          hrefLang={HTML_LANG[loc]}
          href={`${origin}${swapLocalePath(location.pathname, loc)}`}
        />
      ))}
      <link
        rel="alternate"
        hrefLang="x-default"
        href={`${origin}${swapLocalePath(location.pathname, 'bg')}`}
      />
      <RouteProgress />
      <a className="skip" href="#main">
        {t('a11y.skip')}
      </a>
      <SiteHeader />
      <Outlet />
      <SiteFooter
        asOf={loaderData.asOf}
        refreshedAt={loaderData.refreshedAt}
        endYear={loaderData.coverageEndYear}
      />
      <AccessibilityWidget />
    </>
  );
}

// Errors render inside the chrome so a 404/500 still looks like СИГМА and keeps the nav.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // Locale comes from LocaleProvider in Layout (which wraps this boundary too), so there is no separate
  // URL-prefix derivation here — one source of truth for the whole document.
  const t = useTranslation();
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const kicker = is404 ? t('error.kicker404') : t('error.kicker');
  const title = is404 ? t('error.title404') : t('error.title');
  const lede = is404 ? t('error.lede404') : t('error.lede');
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <>
      {/* The boundary bypasses route `meta`, so set the document title here (React hoists it). */}
      <title>{is404 ? t('error.docTitle404') : t('error.docTitle')}</title>
      <a className="skip" href="#main">
        {t('a11y.skip')}
      </a>
      <SiteHeader />
      <main id="main">
        <PageHeader kicker={kicker} title={title} lede={lede} />
        <p className="muted">
          <Link to="/">{t('nav.home')}</Link> · <Link to="/companies">{t('nav.companies')}</Link> ·{' '}
          <Link to="/authorities">{t('nav.authorities')}</Link> ·{' '}
          <Link to="/contracts">{t('nav.contracts')}</Link>
        </p>
        {stack && (
          <pre className="mono small error-stack">
            <code>{stack}</code>
          </pre>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
