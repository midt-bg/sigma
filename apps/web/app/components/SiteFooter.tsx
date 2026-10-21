import { Link } from 'react-router';
import { date } from '@sigma/shared';
import { coverageEndYear, coverageRange } from '../lib/coverage';
import { Abbr, NewTabLink } from './ui';

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
          Източник (CC-BY 4.0): <Abbr>АОП</Abbr> / <Abbr>ЦАИС ЕОП</Abbr> — отворени данни
          (storage.eop.bg) · {range}
          {asOf ? ` · последен договор ${date(asOf)}` : ''}
          {refreshedAt ? ` · данни обновени ${date(refreshedAt)}` : ''}
        </span>
        <Link to="/methodology">Методология</Link>
        <Link to="/accessibility">Достъпност</Link>
        <Link to="/privacy">Поверителност</Link>
        <Link to="/impressum">Импресум</Link>
        <NewTabLink className="repo-link" href="https://github.com/midt-bg/sigma">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
          Отворен код
        </NewTabLink>
      </div>
    </footer>
  );
}
