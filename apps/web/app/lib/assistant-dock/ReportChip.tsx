import { Link } from 'react-router';

interface ReportChipProps {
  title: string;
  leadStat: string | null;
  /** Canonical report URL (`/reports/:id`). Absent until the report route + id land — then „Отвори" shows. */
  href?: string;
  /** Called when the user taps „Отвори" — used on mobile to close the dock before navigating. */
  onOpen?: () => void;
}

/**
 * Compact card for a finished report in the chat transcript: title + one lead statistic + an „Отвори"
 * link to the full report. Project a `ResolvedReport` with `projectChip` (report-projection) and pass
 * the result plus the report URL.
 */
export const ReportChip = ({ title, leadStat, href, onOpen }: ReportChipProps) => (
  <article className="report-chip">
    <h3 className="report-chip__title">{title}</h3>
    {leadStat !== null ? <p className="report-chip__stat">{leadStat}</p> : null}
    {href !== undefined ? (
      <Link className="report-chip__open" to={href} onClick={onOpen}>
        Отвори
      </Link>
    ) : null}
  </article>
);
