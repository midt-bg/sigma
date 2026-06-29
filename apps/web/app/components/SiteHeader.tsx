import { useEffect, useId, useRef, useState } from 'react';
import { Link as RRLink, useLocation, useSearchParams } from 'react-router';
import { Link, NavLink } from '../i18n/Link';
import { SmartSearch } from './SmartSearch';
import { useLocale, useTranslation } from '../i18n/context';
import { swapLocalePath, stripLocale, LOCALES } from '../i18n/locale';
import type { MessageKey } from '../i18n/t';
import { ANALYTICS_NAV_PATHS } from '../lib/analytics-lenses';

type NavItem = {
  to: string;
  label: MessageKey;
  end?: boolean;
  activePaths?: string[];
};

// Restructured nav: the analytics family (flows / network / trends / map / competition / analytics)
// collapses behind one „Анализи" entry that highlights for any of its lens routes (ANALYTICS_NAV_PATHS).
const NAV: NavItem[] = [
  { to: '/', label: 'nav.home', end: true },
  { to: '/authorities', label: 'nav.authorities' },
  { to: '/companies', label: 'nav.companies' },
  { to: '/contracts', label: 'nav.contracts' },
  { to: '/analytics', label: 'nav.analytics', activePaths: [...ANALYTICS_NAV_PATHS] },
  { to: '/methodology', label: 'nav.methodology' },
];

function pathMatches(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

// Masthead: serif brand + mono nav. The search icon opens a drawer below the mast; on mobile the
// nav collapses into a slide-in drawer with a dimmed backdrop. All interaction is React state — no
// external script — so the strict CSP needs no script allowance beyond the framework nonce. SSR
// renders everything closed; the handlers wire up on hydration.
export function SiteHeader() {
  const t = useTranslation();
  const locale = useLocale();
  const location = useLocation();
  const [searchParams] = useSearchParams();
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
      const target = e.target as Node;
      if (drawerRef.current?.contains(target) || searchToggleRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [searchOpen]);

  // Returning to the desktop layout clears an open mobile nav.
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
        <div className="site-header-inner">
          <Link
            className="brand"
            to="/"
            aria-label={t('brand.aria')}
            title={t('brand.title')}
            inert={navOpen}
          >
            <img className="brand-logo" src="/logo.svg" width={523} height={115} alt="СИГМА" />
            <span className="brand-sub">{t('brand.sub')}</span>
          </Link>
          <nav
            className={`site-nav${navOpen ? ' is-open' : ''}`}
            id={navId}
            aria-label={t('nav.aria')}
          >
            <div className="site-nav-head">
              <span className="site-nav-head-label">{t('nav.drawerLabel')}</span>
              <button
                ref={navCloseRef}
                type="button"
                className="site-nav-close"
                aria-label={t('nav.close')}
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
              // Strip the locale prefix first so the match works on /en too (paths are bg-rooted).
              if (item.activePaths) {
                const active = item.activePaths.some((path) =>
                  pathMatches(stripLocale(location.pathname), path),
                );
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'active' : undefined}
                    onClick={() => setNavOpen(false)}
                  >
                    {t(item.label)}
                  </Link>
                );
              }
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setNavOpen(false)}
                >
                  {t(item.label)}
                </NavLink>
              );
            })}
          </nav>
          <div className="site-actions" inert={navOpen}>
            {/* Language switcher — plain (non-localizing) links pointing at the same page in the other
                locale, preserving the current query. Crawlable; no inline handler, so CSP-clean. */}
            <div className="lang-switch" role="group" aria-label={t('lang.group')}>
              {LOCALES.map((loc) =>
                loc === locale ? (
                  <span key={loc} className="lang-current" aria-current="true">
                    {loc.toUpperCase()}
                  </span>
                ) : (
                  <RRLink
                    key={loc}
                    className="lang-link"
                    to={`${swapLocalePath(location.pathname, loc)}${location.search}`}
                    hrefLang={loc}
                    aria-label={t('lang.switchTo', { lang: t(`lang.${loc}`) })}
                  >
                    {loc.toUpperCase()}
                  </RRLink>
                ),
              )}
            </div>
            <button
              ref={searchToggleRef}
              className="nav-search"
              type="button"
              aria-label={t('search.toggle')}
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
              <span className="nav-search-text">{t('search.toggle')}</span>
            </button>
            <button
              ref={navToggleRef}
              className="nav-toggle"
              type="button"
              aria-label={t('search.menu')}
              aria-expanded={navOpen}
              aria-controls={navId}
              onClick={() => setNavOpen((v) => !v)}
            >
              <span className="nav-toggle-box" aria-hidden="true">
                <span />
                <span />
              </span>
              <span className="nav-toggle-text">{t('search.menu')}</span>
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
            aria-label={t('search.close')}
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
