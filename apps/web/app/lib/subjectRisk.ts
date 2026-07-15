import type { SubjectRiskAggregate } from '@sigma/api-contract';

// #229 presentation thresholds — server-side constants, NEVER query params (ADR-0007). Band cutoffs are
// provisional, to be calibrated against the real distribution. Pure logic: keys + numbers only — the
// Bulgarian band/component labels live in the SubjectRiskIndicator component, not here.
export const MIN_ELIGIBLE = 5; // a component needs ≥ this many assessable contracts to be reportable (M3)

export type RiskBandKey = 'few' | 'some' | 'many' | 'most';
export type RiskComponentKey = 'single_offer' | 'high_markup';

// The band is chosen from the count-weighted composite (robust to one dominant contract); value shares
// are context only. 'most' (Infinity) always matches, so bandFor never falls through.
const BAND_CUTOFFS: readonly { key: RiskBandKey; below: number }[] = [
  { key: 'few', below: 0.1 },
  { key: 'some', below: 0.3 },
  { key: 'many', below: 0.55 },
  { key: 'most', below: Infinity },
];

function bandFor(composite: number): RiskBandKey {
  return BAND_CUTOFFS.find((b) => composite < b.below)?.key ?? 'most';
}

export interface SubjectRiskComponent {
  key: RiskComponentKey;
  k: number; // flagged contracts
  n: number; // eligible contracts (the „K от N" denominator)
  countShare: number; // k / n ∈ [0,1]
  valueShare: number | null; // ∈ [0,1], or null when no positive eligible value
}

export interface SubjectRiskView {
  composite: number; // mean of the reportable components' count shares ∈ [0,1]
  band: RiskBandKey;
  components: SubjectRiskComponent[]; // reportable only (n ≥ MIN_ELIGIBLE)
}

function toReportable(
  key: RiskComponentKey,
  k: number | null,
  n: number | null,
  valueShare: number | null,
): SubjectRiskComponent | null {
  if (n == null || n < MIN_ELIGIBLE) return null;
  const flagged = k ?? 0;
  return { key, k: flagged, n, countShare: flagged / n, valueShare };
}

/** Display-ready subject risk, or null when it must be suppressed: a natural-person profile (M9) or no
 *  component with enough assessable contracts to be reportable (M3 — then no band and no score render). */
export function buildSubjectRisk(
  agg: SubjectRiskAggregate | null,
  opts: { isNaturalPerson: boolean },
): SubjectRiskView | null {
  if (opts.isNaturalPerson || agg == null) return null;

  const components = [
    toReportable('single_offer', agg.singleOfferK, agg.singleOfferN, agg.singleOfferValueShare),
    toReportable('high_markup', agg.highMarkupK, agg.highMarkupN, agg.highMarkupValueShare),
  ].filter((c): c is SubjectRiskComponent => c !== null);

  if (components.length === 0) return null;

  const composite = components.reduce((sum, c) => sum + c.countShare, 0) / components.length;
  return { composite, band: bandFor(composite), components };
}
