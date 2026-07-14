// Anomaly signal badges — the pure display mapping from an AnomalyListItem's fired signals to the
// red-flag chips on /anomalies. Kept out of the route component so the copy/formatting is unit
// tested. Formatting is hand-rolled like @sigma/shared/format: workerd does not carry the bg-BG
// Intl data, so no Intl/toLocaleString here.
import type { AnomalySignals } from '@sigma/api-contract';
import type { AnomalySignalKey } from '@sigma/config';
import { count, money, signedPct } from '@sigma/shared';

export interface AnomalyBadge {
  key: AnomalySignalKey;
  /** Headline chip text, e.g. „×2,5 над прогнозата". */
  label: string;
  /** Baseline evidence rendered de-emphasised inside the chip, e.g. „(при 102 хил. €)". */
  detail: string | null;
  /** true → context signal (soft chip variant), never the reason the row exists. */
  context: boolean;
}

/** „×2,5" / „×12" / „×104 528" — one decimal under 100 (trailing „,0" dropped, comma decimal),
 *  whole numbers with the thousands NBSP above. */
export function formatTimes(ratio: number): string {
  const body =
    ratio >= 100 ? count(Math.round(ratio)) : String(Number(ratio.toFixed(1))).replace('.', ',');
  return `×${body}`;
}

/**
 * The chips for one row, in severity order (price signals first, context last). Ratio fields are
 * already flag-gated by the query layer (non-null ⇔ the signal fired), so presence alone decides.
 */
export function anomalyBadges(s: AnomalySignals): AnomalyBadge[] {
  const badges: AnomalyBadge[] = [];
  if (s.overEstimateRatio != null) {
    badges.push({
      key: 'over_estimate',
      label: `${formatTimes(s.overEstimateRatio)} над прогнозата`,
      detail: s.estimatedEur != null ? `(при ${money(s.estimatedEur)})` : null,
      context: false,
    });
  }
  if (s.annexGrowthRatio != null) {
    badges.push({
      key: 'annex_growth',
      label: `${signedPct(s.annexGrowthRatio - 1, 0)} чрез анекси`,
      detail: null,
      context: false,
    });
  }
  if (s.priceRatio != null) {
    badges.push({
      key: 'price_outlier',
      label: `${formatTimes(s.priceRatio)} над типичното`,
      detail:
        s.peerMedianEur != null
          ? `(медиана ${money(s.peerMedianEur)}${
              s.peerCount != null ? ` от ${count(s.peerCount)} договора` : ''
            })`
          : null,
      context: false,
    });
  }
  if (s.singleBid) {
    badges.push({ key: 'single_bid', label: 'единствена оферта', detail: null, context: true });
  }
  if (s.noNotice) {
    badges.push({ key: 'no_notice', label: 'без обявление', detail: null, context: true });
  }
  return badges;
}
