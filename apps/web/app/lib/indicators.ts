import type { ContractListItem } from '@sigma/api-contract';

export interface ContractIndicator {
  label: string;
  /** Competition-risk fact → red tag. Everything else is a neutral fact. */
  risk: boolean;
}

/**
 * Factual indicator tags for a contract row, shared by the home „открояват се" list and the
 * /contracts table so the two surfaces can never disagree about what a row is flagged for.
 *
 * ONLY indicators backed by a field the list query actually returns are produced. The design sheets
 * also show „99,8% от прогнозата" and „анекс +18%", which need the signing/estimate ratio and the
 * amendment delta that the handoff lists as NEW derived fields — neither is on ContractListItem, so
 * they are omitted rather than approximated. An indicator a transparency portal cannot back with a
 * stored fact has no business being on the page; add them here once the loader derives them.
 *
 * Callers pair a red tag with the 3px `--risk` edge mark, never the edge alone, so the signal does
 * not depend on colour (WCAG 1.4.1).
 */
export function contractIndicators(c: ContractListItem): ContractIndicator[] {
  const out: ContractIndicator[] = [];
  if (c.bidsReceived === 1) out.push({ label: '1 оферта', risk: true });
  else if (c.bidsReceived != null && c.bidsReceived > 1)
    out.push({ label: `${c.bidsReceived} оферти`, risk: false });
  if (c.euFunded) out.push({ label: 'ЕС финансиране', risk: false });
  if (c.isConsortium) out.push({ label: 'обединение', risk: false });
  return out;
}

/** True when a row carries at least one competition-risk fact (drives the red edge mark). */
export function isFlagged(c: ContractListItem): boolean {
  return contractIndicators(c).some((i) => i.risk);
}
