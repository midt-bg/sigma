import { useEffect, useRef } from 'react';
import {
  isRouteErrorResponse,
  Link,
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
import './app.css';

// The editorial design uses a system serif/mono/sans stack (see app.css @theme) — no webfont request.
// Brand favicons (white „С“ on the deep-red tile) live in /public; declare them so the head is explicit.
export const links: Route.LinksFunction = () => [
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
  return { ...coverage, origin: url.origin };
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
  const rootData = useRouteLoaderData('root') as { origin?: string } | undefined;
  const imageUrl = rootData?.origin ? `${rootData.origin}/og.png` : undefined;
  return (
    <html lang="bg">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="СИГМА" />
        <meta property="og:locale" content="bg_BG" />
        {imageUrl && (
          <>
            <meta property="og:image" content={imageUrl} />
            <meta property="og:image:width" content="1200" />
            <meta property="og:image:height" content="630" />
            <meta
              property="og:image:alt"
              content="СИГМА — платформа за прозрачност на обществените поръчки"
            />
            <meta property="og:image:type" content="image/png" />
          </>
        )}
        <meta name="twitter:card" content="summary_large_image" />
        {imageUrl && <meta name="twitter:image" content={imageUrl} />}
        <Meta />
        <Links />
        <script src="/assets/accessibility/accessibility.js" defer />
      </head>
      <body>
        {children}
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

  return (
    <>
      <RouteProgress />
      <a className="skip" href="#main">
        Към съдържанието
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
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const kicker = is404 ? 'Грешка 404' : 'Грешка';
  const title = is404 ? 'Страницата не е намерена' : 'Възникна грешка';
  const lede = is404
    ? 'Такъв запис няма или адресът се е променил. Започни от търсенето или от някой от списъците.'
    : 'Нещо се обърка при зареждането. Опитай пак или се върни в началото.';
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <>
      {/* The boundary bypasses route `meta`, so set the document title here (React hoists it). */}
      <title>{is404 ? 'Страницата не е намерена — СИГМА' : 'Грешка — СИГМА'}</title>
      <a className="skip" href="#main">
        Към съдържанието
      </a>
      <SiteHeader />
      <main id="main">
        <PageHeader kicker={kicker} title={title} lede={lede} />
        <p className="muted">
          <Link to="/">Начало</Link> · <Link to="/companies">Компании</Link> ·{' '}
          <Link to="/authorities">Институции</Link> · <Link to="/contracts">Договори</Link>
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
