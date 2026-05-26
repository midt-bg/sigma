import { useEffect, useId, useRef, useState } from "react";
import { NavLink } from "react-router";

const NAV = [
  { to: "/", label: "Начало", end: true },
  { to: "/authorities", label: "Институции" },
  { to: "/companies", label: "Компании" },
  { to: "/contracts", label: "Договори" },
  { to: "/flows", label: "Потоци" },
  { to: "/methodology", label: "Методология" },
];

const PLACEHOLDER = "Институция, компания, ЕИК или № на договор…";

// Masthead: serif brand + mono nav + a search drawer that slides below. Ports mocks/v1/assets/site.js
// (open/close, Esc, click-outside, mobile nav collapse) into React state — no external script, so the
// strict CSP needs no script allowance beyond the framework nonce. SSR renders both closed; the
// handlers wire up on hydration.
export function SiteHeader() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const drawerId = useId();
  const navId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);

  // Focus the field when the drawer opens.
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  // Esc closes whichever is open (and returns focus to the search toggle).
  useEffect(() => {
    if (!searchOpen && !navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchOpen) {
        setSearchOpen(false);
        searchToggleRef.current?.focus();
      }
      setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchOpen, navOpen]);

  // Click outside the search drawer closes it.
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (drawerRef.current?.contains(t) || searchToggleRef.current?.contains(t)) return;
      setSearchOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [searchOpen]);

  // Returning to the desktop layout clears an open mobile nav.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 961px)");
    const onChange = (e: MediaQueryListEvent) => e.matches && setNavOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <header className="site-header" role="banner">
        <div className="site-header-inner">
          <NavLink className="brand" to="/" aria-label="Сигма — начална страница">
            <span className="brand-mark">Сигма</span>
            <span className="brand-sub">Платформа за прозрачни възлагания</span>
          </NavLink>
          <nav className={`site-nav${navOpen ? " is-open" : ""}`} id={navId} aria-label="Главна навигация">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setNavOpen(false)}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="site-actions">
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
                <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
                <line x1="15.4" y1="15.4" x2="20" y2="20" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
            <button
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

      <div
        ref={drawerRef}
        className={`search-drawer${searchOpen ? " is-open" : ""}`}
        id={drawerId}
        inert={!searchOpen}
      >
        <form className="search-drawer-form" role="search" action="/search" method="get">
          <span className="search-drawer-prompt" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            type="search"
            name="q"
            placeholder={PLACEHOLDER}
            aria-label="Търсене"
            autoComplete="off"
          />
          <button type="submit">Намери</button>
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
        </form>
      </div>
    </>
  );
}
