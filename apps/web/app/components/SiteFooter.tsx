import { Link } from 'react-router';
import { date } from '@sigma/shared';
import { DATA_SOURCE_LICENSE } from '../lib/dataSource';
import { coverageEndYear, coverageRange } from '../lib/coverage';

// Single mono-caps line: source + coverage window + source and refresh dates.
export function SiteFooter({
  asOf,
  refreshedAt,
  endYear,
}: {
  asOf?: string | null;
  refreshedAt?: string | null;
  endYear?: number | null;
}) {
  const range = coverageRange(endYear ?? coverageEndYear(asOf));
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="site-footer-inner">
        <span>
          {DATA_SOURCE_LICENSE} · {range}
          {asOf ? ` · последен договор ${date(asOf)}` : ''}
          {refreshedAt ? ` · данни обновени ${date(refreshedAt)}` : ''}
        </span>
        <Link to="/methodology">Методология</Link>
        <Link to="/accessibility">Достъпност</Link>
        <Link to="/privacy">Поверителност</Link>
        <Link to="/impressum">Импресум</Link>
      </div>
    </footer>
  );
}
