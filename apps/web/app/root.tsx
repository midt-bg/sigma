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
} from 'react-router';

import type { Route } from './+types/root';
import { useNonce } from './nonce';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import { AccessibilityWidget } from './components/AccessibilityWidget';
import { PageHeader } from './components/PageHeader';
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

// One cheap read for the chrome: the data current-as-of date shown in the footer on every page.
export async function loader({ context, request }: Route.LoaderArgs) {
  // Canonicalise away a trailing slash so `/companies/` (which otherwise silently renders the list
  // and triggers a hydration mismatch) becomes `/companies`. Root loader runs for every route.
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    throw redirect(url.pathname.replace(/\/+$/, '') + url.search, 301);
  }
  const row = await context.cloudflare.env.DB.prepare(
    'SELECT as_of FROM home_totals WHERE id = 1',
  ).first<{ as_of: string | null }>();
  return { asOf: row?.as_of ?? null };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useNonce();
  return (
    <html lang="bg">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script src="/assets/accessibility/accessibility.js" defer />
      </head>
      <body>
        {children}
        <ScrollRestoration nonce={nonce} />
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
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        insetInline: 0,
        top: 0,
        height: '2px',
        background: 'var(--accent)',
        transformOrigin: 'left',
        transform: busy ? 'scaleX(1)' : 'scaleX(0)',
        opacity: busy ? 1 : 0,
        transition: busy
          ? 'transform 1.2s ease-out, opacity 0.1s ease'
          : 'transform 0.1s ease, opacity 0.25s ease 0.15s',
        zIndex: 1000,
        pointerEvents: 'none',
      }}
    />
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  // After a client-side navigation, move focus to the main region so keyboard and
  // screen-reader users aren't stranded on <body> mid-page (and the skip link stays
  // reachable). Skip the first run so SSR/hydration and the initial load are untouched.
  const location = useLocation();
  const navigationType = useNavigationType();
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
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
      <SiteFooter asOf={loaderData.asOf} />
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
    ? 'Записът не съществува или адресът е променен. Започни от търсенето или от някой от списъците.'
    : 'Нещо се обърка при зареждането. Опитай отново или се върни към началото.';
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
          <pre className="mono small" style={{ overflowX: 'auto', marginTop: 'var(--s-5)' }}>
            <code>{stack}</code>
          </pre>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
