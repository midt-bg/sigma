import { Fragment } from 'react';
import { Link } from '../i18n/Link';
import { useTranslation } from '../i18n/context';

export interface Crumb {
  label: string;
  to?: string; // omit for the current (last) item
}

// Mono-caps breadcrumb strip. The last crumb (no `to`) is the current page (plain text).
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const t = useTranslation();
  return (
    <nav className="crumbs" aria-label={t('breadcrumbs.aria')}>
      <div className="crumbs-inner">
        {items.map((c, i) => (
          <Fragment key={c.to ?? c.label}>
            {i > 0 && <span className="sep">›</span>}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}
