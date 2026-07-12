import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import type { RegionTopBeneficiary } from '@sigma/db';

// Pure logic for the /map choropleth + Information Card, extracted from components/Choropleth.tsx so it
// can be unit-tested (the repo's convention is pure-logic lib/*.test.ts; there are no component render
// tests). The component imports these and behaves identically.

export type Grouping = 'oblast' | 'region';

// Quantile tiers over the non-zero values, so one dominant zone (София) does not flatten the rest.
// Returns a tier in 0..5 (0 = no/negligible spend). Note: the 0.8 break equals the max for small N,
// so the maximum value lands in tier 4 and only values strictly above a break climb higher.
export function tierer(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const breaks = [at(0.2), at(0.4), at(0.6), at(0.8)];
  return (v) => (v <= 0 ? 0 : 1 + breaks.filter((b) => v > b).length);
}

// Share of the attributed total, guarded against a zero/absent denominator (→ 0, never NaN/Infinity).
export function shareOfTotal(value: number, total: number | undefined): number {
  return total && total > 0 ? value / total : 0;
}

// The card's share-stat label, mode-aware: the numerator is an oblast (NUTS3) in oblast mode and a
// район (NUTS2) in район mode. The denominator is identical in both modes (the районs partition the
// same oblasts), so only the noun changes — this keeps the label accurate, not just the number.
export function shareLabel(group: Grouping): string {
  return group === 'region' ? 'Дял от всички райони' : 'Дял от всички области';
}

// Colour tier for a geometry path (always a NUTS3 oblast), by mode: its own oblast value in oblast
// mode, or its parent район's (NUTS2) aggregate value in район mode.
export function tierForShape(
  r: RegionSpend | undefined,
  group: Grouping,
  macroByNuts2: Map<string, MacroRegionSpend>,
  tierOblast: (v: number) => number,
  tierRegion: (v: number) => number,
): number {
  if (!r) return 0;
  if (group === 'region') return tierRegion(macroByNuts2.get(r.nuts2)?.valueEur ?? 0);
  return tierOblast(r.valueEur);
}

// A path is highlighted when it is the hovered oblast (oblast mode) or shares the hovered район
// (район mode — the whole район lights up).
export function isActiveShape(
  r: RegionSpend | undefined,
  hoveredRegion: RegionSpend | null,
  group: Grouping,
): boolean {
  if (!r || !hoveredRegion) return false;
  return group === 'region' ? r.nuts2 === hoveredRegion.nuts2 : r.nuts3 === hoveredRegion.nuts3;
}

// Click/tap target for the *pinned* selection, given the currently selected nuts3. A click always
// toggles the pin the same way on fine and coarse pointers alike: clicking the already-pinned region
// deselects it, clicking a different (or previously unselected) region moves the pin there. Unlike
// hover, `selected` only ever changes on click — never on mouseenter/mouseleave — so there is no
// fine/coarse pointer ambiguity to resolve here the way the old hover-as-selection code needed.
export function nextSelected(nuts3: string | undefined, selected: string | null): string | null {
  if (!nuts3) return selected;
  if (selected === nuts3) return null;
  return nuts3;
}

// The resolved active key driving the card + highlight: a pin always wins over a transient hover,
// so leaving the map (which clears `hovered`) never empties a pinned card.
export function resolveActiveKey(selected: string | null, hovered: string | null): string | null {
  return selected ?? hovered;
}

// Top-3-bidders list for the Information Card, only meaningful at oblast (NUTS3) level — a район
// aggregates several oblasts, so there is no single "region total" a район-level share would be
// against. Undefined in район mode, when nothing is hovered, or when the loader has no entry for
// that oblast (e.g. it had no attributed bidders at all).
export function activeTopBeneficiaries(
  group: Grouping,
  hoveredRegion: RegionSpend | null,
  topBeneficiaries: Record<string, RegionTopBeneficiary[]> | undefined,
): RegionTopBeneficiary[] | undefined {
  if (group !== 'oblast' || !hoveredRegion) return undefined;
  return topBeneficiaries?.[hoveredRegion.nuts3];
}
