import {
  COMPETITION_MIN_CONTRACTS,
  type IndicatorRating,
  type IndicatorThresholds,
  rateLowerIsBetter,
} from '@sigma/config';

/** Said instead of a verdict when too few contracts stand behind a share: below the sample /competition
 *  ranks on, one or two contracts decide it, and a verdict would be noise about a named body. */
export const SMALL_SAMPLE_LABEL = `твърде малко договори за сравнение с праговете на ЕС (под ${COMPETITION_MIN_CONTRACTS})`;

/** The EU verdict for a share, or null when fewer than COMPETITION_MIN_CONTRACTS contracts stand behind it. */
export function euRating(
  share: number,
  contracts: number,
  thresholds: IndicatorThresholds,
): IndicatorRating | null {
  return contracts >= COMPETITION_MIN_CONTRACTS ? rateLowerIsBetter(share, thresholds) : null;
}
