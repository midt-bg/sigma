import { Link } from 'react-router';

interface ReportChipProps {
  title: string;
  leadStat: string | null;
  /** Canonical report URL (`/reports/:id`), from the emit_report result. */
  href: string;
}

/**
 * Compact card for a finished report in the chat transcript: title + one lead statistic + an „Отвори"
 * link to the full report. Build the props with `reportViewFromMessage` (report-projection).
 */
export const ReportChip = ({ title, leadStat, href }: ReportChipProps) => (
  <article className="report-chip">
    <h3 className="report-chip__title">{title}</h3>
    {leadStat !== null ? <p className="report-chip__stat">{leadStat}</p> : null}
    <Link className="report-chip__open" to={href}>
      Отвори
    </Link>
  </article>
);
