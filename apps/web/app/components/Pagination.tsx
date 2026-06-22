import { Link } from 'react-router';
import { count as fmtCount } from '@sigma/shared';
import type { PageNav } from '../lib/filters';

// Keyset Prev/Next with a current-page marker + total (no deep page-jumps — those would force OFFSET).
export function Pagination({
  nav,
  pageSize,
  unit,
}: {
  nav: PageNav;
  pageSize: number;
  unit?: string;
}) {
  return (
    <nav className="paging" aria-label="Навигация по страници">
      <div>
        Страница <strong>{fmtCount(nav.page)}</strong> от <strong>{fmtCount(nav.pageCount)}</strong>{' '}
        · по {pageSize} на страница{unit ? ` (${unit})` : ''}
      </div>
      <div className="ctrl">
        {nav.prevHref ? (
          <Link to={nav.prevHref} rel="prev">
            ‹ Предишна
          </Link>
        ) : (
          <span aria-disabled="true" className="disabled" style={{ opacity: 0.4 }}>
            ‹ Предишна
          </span>
        )}
        {nav.nextHref ? (
          <Link to={nav.nextHref} rel="next">
            Следваща ›
          </Link>
        ) : (
          <span aria-disabled="true" className="disabled" style={{ opacity: 0.4 }}>
            Следваща ›
          </span>
        )}
      </div>
    </nav>
  );
}
