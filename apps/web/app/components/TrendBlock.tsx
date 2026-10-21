import type { TrendPoint, TrendYear } from '@sigma/api-contract';
import { count, money, plural } from '@sigma/shared';
import { DataTable } from './DataTable';
import { TrendChart } from './TrendChart';
import { trendYearColumns } from '../lib/entity-tables';

// The "Тренд" section body shared by the company and authority profiles. One rule for what a
// profile gets: two or more periods draw the chart with the year table beside it; a single period
// is one number, so only the table (a chart with one point would be a dot pretending to be a line);
// no dated contracts at all says so. The table is always the accessible path — the SVG is a picture.
export function TrendBlock({
  points,
  years,
  granularity,
  caption,
  split = false,
  omitted,
}: {
  points: TrendPoint[];
  years: TrendYear[];
  granularity: 'month' | 'year';
  caption: string;
  /** Chart and table side by side (full-width sections) instead of stacked (half-width ones). */
  split?: boolean;
  /** Contracts the series leaves out, stated under the table so it adds up to the profile total. */
  omitted?: { contracts: number; valueEur: number };
}) {
  if (points.length === 0 || years.length === 0) {
    return <p className="muted">Няма договори с валидна дата за времева графика.</p>;
  }
  const table = (
    <>
      {/* Half-width sections can clip the four columns at tablet widths, and the rows hold no links. */}
      <DataTable
        columns={trendYearColumns}
        rows={years}
        getKey={(r) => r.year}
        caption={caption}
        scrollable
      />
      {!!omitted?.contracts && (
        <p className="small muted">
          Без валидна дата (липсва, преди 2020&nbsp;г. или в бъдещето): {count(omitted.contracts)}{' '}
          {plural(omitted.contracts, 'договор', 'договора')}, {money(omitted.valueEur)}.
        </p>
      )}
    </>
  );
  if (points.length < 2) return table;
  return (
    <div className={split ? 'trend-split' : undefined}>
      <TrendChart points={points} granularity={granularity} compact />
      <div className={split ? undefined : 'mt-8'}>{table}</div>
    </div>
  );
}
