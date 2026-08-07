import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useRouteLoaderData, useSearchParams } from 'react-router';
import { date } from '@sigma/shared';
import { SmartSearch } from './SmartSearch';
import { ANALYTICS_NAV_PATHS } from '../lib/analytics-lenses';

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  activePaths?: string[];
};

const NAV: NavItem[] = [
  { to: '/', label: 'Начало', end: true },
  { to: '/authorities', label: 'Институции' },
  { to: '/companies', label: 'Компании' },
  { to: '/contracts', label: 'Договори' },
  { to: '/conflicts', label: 'Свързани лица' },
  { to: '/analytics', label: 'Анализи', activePaths: [...ANALYTICS_NAV_PATHS] },
  { to: '/methodology', label: 'Методология' },
];

function pathMatches(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

// Masthead — „technical dossier" direction: a 3-column grid (220px brand / nav / 220px source
// stamp) over a solid 1px rule, with hairline dividers between every nav item. The brand is pure
// CSS/text (a steel-blue Σ square + tracked wordmark), superseding logo.svg.
//
// Everything behavioural is carried over unchanged from the previous masthead: the search drawer,
// the mobile nav drawer with its dimmed backdrop, focus movement on open, Esc-to-close with focus
// return, body-scroll lock, and `inert` on the rest of the header while the drawer is open. All
// interaction is React state — no external script — so the strict CSP needs no allowance beyond the
// framework nonce. SSR renders everything closed; handlers wire up on hydration.
export function SiteHeader() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // The root loader carries coverage metadata for every route; the mast stamps the refresh date.
  const rootData = useRouteLoaderData('root') as { refreshedAt?: string | null } | undefined;
  const refreshedAt = rootData?.refreshedAt ?? null;
  // Prefill from the active query so reopening search on a results page shows it.
  const activeQuery = searchParams.get('q') ?? '';
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const drawerId = useId();
  const navId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const navCloseRef = useRef<HTMLButtonElement>(null);

  // Focus the field when the search drawer opens.
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  // Move focus into the nav drawer when it opens (keyboard users land on the close control).
  useEffect(() => {
    if (navOpen) navCloseRef.current?.focus({ preventScroll: true });
  }, [navOpen]);

  // Lock body scroll behind the open nav drawer so the dimmed page doesn't scroll under it.
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  // Esc closes whichever surface is open (and returns focus to the control that opened it).
  useEffect(() => {
    if (!searchOpen && !navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) {
        setSearchOpen(false);
        searchToggleRef.current?.focus();
      }
      if (navOpen) {
        setNavOpen(false);
        navToggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen, navOpen]);

  // Click outside the search drawer closes it.
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (drawerRef.current?.contains(t) || searchToggleRef.current?.contains(t)) return;
      setSearchOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [searchOpen]);

  // Returning to the desktop layout clears an open mobile nav. 961px matches the `--rail`
  // collapse breakpoint in tokens.css, so the drawer and the rail switch together.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 961px)');
    const onChange = (e: MediaQueryListEvent) => e.matches && setNavOpen(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const closeNav = () => {
    setNavOpen(false);
    navToggleRef.current?.focus();
  };

  return (
    <>
      <header className="site-header" role="banner">
        <div className="mast-brand" inert={navOpen}>
          <Link
            className="brand"
            to="/"
            aria-label="СИГМА — начална страница"
            title="Система за интегриран граждански мониторинг и анализ на обществените поръчки"
          >
            {/* Brand mark. WCAG 1.4.3 exempts logotypes from the contrast minimum, so the Σ keeps
                the designed --accent fill rather than the darker accent-700 used for UI labels. */}
            <span className="brand-mark" aria-hidden="true">
              Σ
            </span>
            <span className="brand-word">СИГМА</span>
          </Link>
        </div>

        <nav
          className={`site-nav${navOpen ? ' is-open' : ''}`}
          id={navId}
          aria-label="Главна навигация"
        >
          <div className="site-nav-head">
            <span className="site-nav-head-label">Навигация</span>
            <button
              ref={navCloseRef}
              type="button"
              className="site-nav-close"
              aria-label="Затвори менюто"
              onClick={closeNav}
            >
              ×
            </button>
          </div>
          {NAV.map((item) => {
            // „Анализи" must highlight for the whole analytics family (its lens routes), not just
            // /analytics. NavLink derives aria-current from its own `to` match and overrides a
            // passed prop, so for the grouped entry we use a plain Link and drive aria-current
            // (which the existing `a[aria-current='page']` styles) from a prefix match ourselves.
            if (item.activePaths) {
              const active = item.activePaths.some((path) => pathMatches(location.pathname, path));
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={active ? 'active' : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  {item.label}
                </Link>
              );
            }
            return (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setNavOpen(false)}>
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="mast-meta" inert={navOpen}>
          <div className="mast-stamp">
            <span>ЦАИС ЕОП</span>
            {refreshedAt ? <span>обновено {date(refreshedAt)}</span> : null}
          </div>
          <div className="mast-actions">
            <button
              ref={searchToggleRef}
              className="nav-search"
              type="button"
              aria-label="Търсене"
              aria-expanded={searchOpen}
              aria-controls={drawerId}
              onClick={() => setSearchOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle
                  cx="10.5"
                  cy="10.5"
                  r="6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                />
                <line
                  x1="15.4"
                  y1="15.4"
                  x2="20"
                  y2="20"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
              <span className="nav-search-text">Търсене</span>
            </button>
            <button
              ref={navToggleRef}
              className="nav-toggle"
              type="button"
              aria-label="Меню"
              aria-expanded={navOpen}
              aria-controls={navId}
              onClick={() => setNavOpen((v) => !v)}
            >
              <span className="nav-toggle-box" aria-hidden="true">
                <span />
                <span />
              </span>
              <span className="nav-toggle-text">Меню</span>
            </button>
          </div>
        </div>
      </header>

      {/* Dimmed backdrop behind the mobile nav drawer — pointer convenience; Esc and the × also close. */}
      <div
        className={`nav-backdrop${navOpen ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={closeNav}
      />

      <div
        ref={drawerRef}
        className={`search-drawer${searchOpen ? ' is-open' : ''}`}
        id={drawerId}
        inert={!searchOpen || navOpen}
      >
        <div className="search-drawer-inner">
          <SmartSearch
            variant="drawer"
            defaultValue={activeQuery}
            inputRef={inputRef}
            onNavigate={() => setSearchOpen(false)}
          />
          <button
            type="button"
            className="search-drawer-close"
            aria-label="Затвори търсенето"
            onClick={() => {
              setSearchOpen(false);
              searchToggleRef.current?.focus();
            }}
          >
            ×
          </button>
        </div>
      </div>
    </>
  );
}
