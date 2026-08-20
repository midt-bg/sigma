import { money } from '@sigma/shared';

// The one net-new digest chart (plan Phase 3.3 / spec §3.4): a weekly vertical bar chart of daily
// spend, with lighter "ghost" bars behind for the SAME day of the previous week, so a reader sees this
// week against last without reading a decline into missing data. Server-rendered static SVG (no chart
// JS, like TrendChart/SankeyDiagram) so it works in the post, the social card and email. role="img" +
// aria-label, paired with a screen-reader table (WCAG AA — the site convention for every chart).

export interface DayValue {
  label: string; // day label, e.g. „Пн" or a date
  value: number; // EUR
}

const W = 760;
const H = 240;
const PAD_B = 24; // room for day labels
const PAD_T = 12;
const PLOT_H = H - PAD_B - PAD_T;

export function WeeklyGhostBars({
  current,
  previous,
  ariaLabel = 'Разход по дни за седмицата',
  caption = 'Разход по дни (тази седмица спрямо миналата)',
}: {
  current: DayValue[];
  previous?: DayValue[];
  ariaLabel?: string;
  caption?: string;
}) {
  if (current.length === 0) return null;
  const n = current.length;
  // Pair the two series by LABEL, not array index (#81 review): the binder drops null-valued days per
  // series, so a mid-series gap in one week could otherwise shift the index pairing (a prior-week „Вт"
  // rendered under the current-week „Ср"). Looking prev up by label keeps each ghost bar under its own
  // day for any input, not only the digest's zero-filled 7 Mon..Sun slots. Assumes unique labels within
  // a series (true for day names); a duplicate label would collapse in the map, which is acceptable for
  // this chart's use. `prevByLabel` maps day label → prior-week value.
  const prev = previous ?? [];
  const prevByLabel = new Map(prev.map((d) => [String(d.label), d.value]));
  const max = Math.max(1, ...current.map((d) => d.value), ...prev.map((d) => d.value));
  const slot = W / n;
  const ghostW = slot * 0.62; // wider, sits behind
  const barW = slot * 0.4; // narrower, sits in front, centred in the slot
  const baseline = H - PAD_B;
  const barHeight = (v: number) => (Math.max(0, v) / max) * PLOT_H;

  return (
    <>
      {/* Visible key so a reader knows which bars are this week vs the prior-week ghosts. aria-hidden —
          the sr-only table below already labels both series for assistive tech. The ghost item appears
          only when there IS a prior-week series to compare against. */}
      <ul className="gb-legend" aria-hidden="true">
        <li className="gb-legend__item">
          <span className="gb-legend__swatch gb-legend__swatch--current" />
          Тази седмица
        </li>
        {prev.length > 0 && (
          <li className="gb-legend__item">
            <span className="gb-legend__swatch gb-legend__swatch--ghost" />
            Миналата седмица
          </li>
        )}
      </ul>
      <svg className="ghost-bars-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        <line x1={0} y1={baseline} x2={W} y2={baseline} className="grid" />
        {current.map((d, i) => {
          const cx = i * slot + slot / 2;
          const prevVal = prevByLabel.get(String(d.label)) ?? null;
          const curH = barHeight(d.value);
          return (
            <g key={i}>
              {prevVal != null && (
                <rect
                  className="gb-ghost"
                  x={cx - ghostW / 2}
                  y={baseline - barHeight(prevVal)}
                  width={ghostW}
                  height={barHeight(prevVal)}
                  fill="currentColor"
                  fillOpacity={0.18}
                />
              )}
              <rect
                className="gb-bar"
                x={cx - barW / 2}
                y={baseline - curH}
                width={barW}
                height={curH}
                fill="currentColor"
                fillOpacity={0.72}
              />
              <text x={cx} y={H - 7} textAnchor="middle" className="label">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Ден</th>
            <th scope="col">Тази седмица (€)</th>
            {/* Only when there IS a prior week — otherwise the column announces an all-em-dash series. */}
            {prev.length > 0 && <th scope="col">Миналата седмица (€)</th>}
          </tr>
        </thead>
        <tbody>
          {/* Rows keyed by LABEL (matching the chart): current days in order, then any prior-week-only
              day appended. A day missing from either week em-dashes that side — never mispaired, never
              dropped. In the digest both weeks are the same 7 Mon..Sun labels. */}
          {(() => {
            const curByLabel = new Map(current.map((d) => [String(d.label), d.value]));
            const labels = [
              ...current.map((d) => String(d.label)),
              ...prev.map((d) => String(d.label)).filter((l) => !curByLabel.has(l)),
            ];
            return labels.map((label) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{curByLabel.has(label) ? money(curByLabel.get(label)!) : '—'}</td>
                {prev.length > 0 && (
                  <td>{prevByLabel.has(label) ? money(prevByLabel.get(label)!) : '—'}</td>
                )}
              </tr>
            ));
          })()}
        </tbody>
      </table>
    </>
  );
}
