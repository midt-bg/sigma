import { clamp, riskBand, round2, type RiskBand } from '@sigma/shared';
import { DEFAULT_RISK_WEIGHTS, type RiskWeights } from '@sigma/config';

export interface RiskSignals {
  /** 0–100: how restrictive / tailored the technical specification looks. */
  spec: number;
  /** 0–100: deviation of the winning price from the market index. */
  price: number;
  /** 0–100: lack of competition (few bidders, single bid). */
  competition: number;
  /** 0–100: likelihood of cartel / related-party bidding. */
  cartel: number;
  /** 0–100: procedural irregularities (short deadlines, late amendments). */
  process: number;
}

export interface RiskResult {
  score: number;
  band: RiskBand;
  signals: RiskSignals;
  weights: RiskWeights;
}

export function computeRiskScore(
  signals: RiskSignals,
  weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
): RiskResult {
  // Non-finite signals are treated as 0 by the NaN-safe shared clamp.
  const norm = (v: number): number => clamp(v, 0, 100);
  const score = round2(
    norm(signals.spec) * weights.spec +
      norm(signals.price) * weights.price +
      norm(signals.competition) * weights.competition +
      norm(signals.cartel) * weights.cartel +
      norm(signals.process) * weights.process,
  );
  return { score, band: riskBand(score), signals, weights };
}
