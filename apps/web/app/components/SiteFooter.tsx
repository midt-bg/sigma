import { Link } from 'react-router';
import { date } from '@sigma/shared';
import { DATA_SOURCE_LICENSE } from '../lib/dataSource';

// Single mono-caps line: source + coverage window + freshness date. `asOf` is the data current-as-of
// date from the root loader (home_totals); omitted gracefully when unavailable (e.g. an error page).
export function SiteFooter({ asOf }: { asOf?: string | null }) {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="site-footer-inner">
        <span>
          {DATA_SOURCE_LICENSE} · 2020–2026{asOf ? ` · обновени ${date(asOf)}` : ''}
        </span>
        <Link to="/methodology">Методология</Link>
        <Link to="/privacy">Поверителност</Link>
        <Link to="/impressum">Импресум</Link>
      </div>
    </footer>
  );
}
