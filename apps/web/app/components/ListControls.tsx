import type { ReactNode } from 'react';
import { useNavigation } from 'react-router';
import { Link } from '../i18n/Link';
import { useTranslation } from '../i18n/context';
import { sortHref } from '../lib/filters';

export interface SortOption {
  value: string;
  label: string;
}

// The strip above a list: a result-count line on the left, sort links on the right. Sort links keep
// the current filters and reset paging (see lib/filters.sortHref).
export function ListControls({
  count,
  base,
  sorts,
  activeSort,
}: {
  count: ReactNode;
  base: URLSearchParams;
  sorts: SortOption[];
  activeSort: string;
}) {
  const t = useTranslation();
  // Reflect in-flight navigation/revalidation so slow networks get quiet feedback.
  const busy = useNavigation().state !== 'idle';
  return (
    <div className="list-controls" aria-busy={busy || undefined}>
      <p className="muted small" aria-live="polite">
        {count}
        {busy ? <span className="muted small"> · {t('listControls.loading')}</span> : null}
      </p>
      <p className="muted small">
        {t('listControls.sortBy')}{' '}
        {sorts.map((s, i) => (
          <span key={s.value}>
            {i > 0 ? ' · ' : ''}
            {s.value === activeSort ? (
              <Link to={sortHref(base, s.value)} aria-current="true">
                <strong>{s.label}</strong>
              </Link>
            ) : (
              <Link to={sortHref(base, s.value)}>{s.label}</Link>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}
