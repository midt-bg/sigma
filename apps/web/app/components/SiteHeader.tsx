import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router';
import { SmartSearch } from './SmartSearch';

const NAV = [
  { to: '/', label: 'Начало', end: true },
  { to: '/authorities', label: 'Институции' },
  { to: '/companies', label: 'Компании' },
  { to: '/contracts', label: 'Договори' },
  { to: '/flows', label: 'Потоци' },
  { to: '/network', label: 'Мрежа' },
  { to: '/trends', label: 'Тренд' },
  { to: '/map', label: 'Карта' },
  { to: '/methodology', label: 'Методология' },
];

// Masthead: serif brand + mono nav. The search icon opens a drawer below the mast; on mobile the
// nav collapses into a slide-in drawer with a dimmed backdrop. All interaction is React state — no
// external script — so the strict CSP needs no script allowance beyond the framework nonce. SSR
// renders everything closed; the handlers wire up on hydration.
export function SiteHeader() {
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
      const t = e.target as Node;
      if (drawerRef.current?.contains(t) || searchToggleRef.current?.contains(t)) return;
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
            aria-label="СИГМА — начална страница"
            title="Система за интегриран граждански мониторинг и анализ на обществените поръчки"
            inert={navOpen}
          >
            <img className="brand-logo" src="/logo.svg" width={523} height={115} alt="СИГМА" />
            <span className="brand-sub">Платформа за прозрачност на обществените поръчки</span>
          </Link>
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
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setNavOpen(false)}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="site-actions" inert={navOpen}>
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
