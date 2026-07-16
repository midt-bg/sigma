import type { IndicatorRating } from '@sigma/config';
import { pct } from '@sigma/shared';

/**
 * One competition indicator benchmarked against the EU Single Market Scoreboard: headline share,
 * a meter with the two EU thresholds as ticks, the verdict in words, and the counts behind it.
 * Used twice on the authority page („Една оферта" / „Пряко възлагане") so both indicators read
 * identically. The meter is illustrative (aria-hidden) — every number also lives in the text; the
 * fill wears the accent only when the share is over the EU „high" threshold, matching .share-bar.warn.
 */
export function EuBenchmarkStat({
  title,
  qualifier,
  share,
  good,
  bad,
  rating,
  ratingLabel,
  detail,
}: {
  title: string;
  qualifier: string;
  share: number;
  good: number;
  bad: number;
  rating: IndicatorRating;
  ratingLabel: string;
  detail: string;
}) {
  const clamped = Math.min(1, Math.max(0, share));
  // Scale so the threshold zone stays readable: at least 2.5× the „high" cutoff, and never
  // tighter than the measured share plus headroom.
  const scaleMax = Math.min(1, Math.max(2.5 * bad, clamped * 1.25));
  const at = (x: number) => `${((x / scaleMax) * 100).toFixed(1)}%`;
  return (
    <div className="ebs">
      <h3 className="ebs-title">{title}</h3>
      <p className="ebs-head">
        <span className="ebs-pct">{pct(clamped)}</span> {qualifier} — <strong>{ratingLabel}</strong>
        .
      </p>
      <div className="ebs-meter" aria-hidden="true">
        <span className="ebs-zone ebs-zone-good" style={{ left: 0, width: at(good) }} />
        <span className="ebs-zone ebs-zone-mid" style={{ left: at(good), width: at(bad - good) }} />
        <span
          className="ebs-zone ebs-zone-high"
          style={{ left: at(bad), width: at(scaleMax - bad) }}
        />
        <i className={rating === 'bad' ? 'warn' : undefined} style={{ width: at(clamped) }} />
        <span className="ebs-tick" style={{ left: at(good) }}>
          <span className="ebs-tick-label">≤ {pct(good)}</span>
        </span>
        <span className="ebs-tick" style={{ left: at(bad) }}>
          <span className="ebs-tick-label">≥ {pct(bad)}</span>
        </span>
      </div>
      <p className="small muted ebs-thresholds">
        Прагове на ЕС: целево ≤ {pct(good)} · високо ≥ {pct(bad)}
      </p>
      <p className="small muted ebs-detail">{detail}</p>
    </div>
  );
}
