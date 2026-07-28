import { useEffect, useState } from 'react';

const SHOW_AFTER_PX = 400;

export function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Assumes document/window-level scrolling (confirmed: the app's inner-scrolling
    // regions — the mobile nav drawer, the search suggestions popover — are both
    // self-contained overlays, not the main content area). If a page ever scrolls via
    // an inner container instead, this threshold check needs to target that container.
    const toggleVisibility = () => {
      if (window.scrollY > SHOW_AFTER_PX) {
        setIsVisible(true);
      } else {
        setIsVisible(false);
      }
    };

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        toggleVisibility();
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    // Initial check in case the page is loaded already scrolled down
    toggleVisibility();

    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToTop = () => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <button
      type="button"
      className={`scroll-to-top ${isVisible ? 'is-visible' : ''}`}
      onClick={scrollToTop}
      aria-label="Към началото"
      aria-hidden={!isVisible}
      tabIndex={isVisible ? 0 : -1}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  );
}
