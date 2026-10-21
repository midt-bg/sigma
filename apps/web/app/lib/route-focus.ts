import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router';

// Which page of a paged list the address shows: the keyset `cursor` plus the display `page`, or '' when
// the address carries neither. A filter or sort change drops both, so it reads as „no paging".
function pagingOf(search: string): string {
  const sp = new URLSearchParams(search);
  const cursor = sp.get('cursor') ?? '';
  const page = sp.get('page') ?? '';
  return cursor || page ? `${cursor}|${page}` : '';
}

// After a client-side navigation, move focus to the page's <h1> (or <main>) so keyboard and
// screen-reader users aren't stranded on <body> or on the link they just followed, far below the fold.
// The first run (SSR/hydration, initial load) is left alone. A query-only change is left alone too —
// ticking a filter or picking a sort must not yank the user back to the top — except paging: Prev/Next
// replace the rows under a stable pathname, so they count as a navigation. For paging the hook also
// returns the pager's „Страница N от M" line for a polite live region, since the heading itself stays
// the same from page to page.
export function useRouteFocus(): string {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [announcement, setAnnouncement] = useState('');
  const prev = useRef<{ pathname: string; paging: string } | null>(null);
  useEffect(() => {
    const before = prev.current;
    const paging = pagingOf(location.search);
    prev.current = { pathname: location.pathname, paging };
    if (!before) return;
    const pathChanged = location.pathname !== before.pathname;
    const paged = !pathChanged && paging !== '' && paging !== before.paging;
    if (!pathChanged && !paged) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('main h1') ?? document.getElementById('main');
      if (el) {
        el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: navigationType === 'POP' });
      }
      const status = paged ? document.querySelector('main .paging-status')?.textContent : '';
      setAnnouncement(status?.replace(/\s+/g, ' ').trim() ?? '');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.key, navigationType]);
  return announcement;
}
