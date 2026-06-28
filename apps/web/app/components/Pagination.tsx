import { Link } from '../i18n/Link';
import { count as fmtCount } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
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
  const t = useTranslation();
  const locale = useLocale();
  return (
    <nav className="paging" aria-label={t('pagination.nav')}>
      <div>
        {t('pagination.page')} <strong>{fmtCount(nav.page, locale)}</strong> {t('pagination.of')}{' '}
        <strong>{fmtCount(nav.pageCount, locale)}</strong> ·{' '}
        {t('pagination.perPage', { size: pageSize })}
        {unit ? ` (${unit})` : ''}
      </div>
      <div className="ctrl">
        {nav.prevHref ? (
          <Link to={nav.prevHref} rel="prev">
            {t('pagination.prev')}
          </Link>
        ) : (
          <span aria-disabled="true" className="disabled" style={{ opacity: 0.4 }}>
            {t('pagination.prev')}
          </span>
        )}
        {nav.nextHref ? (
          <Link to={nav.nextHref} rel="next">
            {t('pagination.next')}
          </Link>
        ) : (
          <span aria-disabled="true" className="disabled" style={{ opacity: 0.4 }}>
            {t('pagination.next')}
          </span>
        )}
      </div>
    </nav>
  );
}
