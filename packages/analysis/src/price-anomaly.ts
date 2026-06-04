import { clamp, round2 } from '@sigma/shared';

export interface PriceObservation {
  item: string;
  unit: string;
  price: number;
  refPrice: number;
}

export interface PriceAnomaly {
  item: string;
  /** Signed deviation from reference: positive = overpriced. */
  deviationPct: number;
  /** 0–100 severity, used as the `price` risk signal. */
  severity: number;
}

/** Returns null when the reference price is unknown or unusable. */
export function detectPriceAnomaly(obs: PriceObservation): PriceAnomaly | null {
  if (!(obs.refPrice > 0)) return null;
  const deviationPct = round2(((obs.price - obs.refPrice) / obs.refPrice) * 100);
  // Severity ramps linearly from 0 at parity to 100 at +/-50% deviation.
  const severity = clamp((Math.abs(deviationPct) / 50) * 100, 0, 100);
  return { item: obs.item, deviationPct, severity: round2(severity) };
}

/** Average severity across known anomalies only; unknown reference prices are ignored. */
export function aggregatePriceSignal(anomalies: (PriceAnomaly | null)[]): number {
  const known = anomalies.filter((a): a is PriceAnomaly => a !== null);
  if (known.length === 0) return 0;
  const total = known.reduce((sum, a) => sum + a.severity, 0);
  return round2(total / known.length);
}
