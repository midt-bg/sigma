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

// Colour tier for a geometry path, by mode. Oblast mode colours a NUTS3 shape by its own value;
// район mode colours a NUTS2 shape directly by that район's own aggregate (each район is now its
// own shape, not several oblasts sharing a fill — no more oblast→район lookup needed here, `entity`
// is simply the shape's own spend record).
export function tierForShape(
  entity: RegionSpend | MacroRegionSpend | undefined,
  group: Grouping,
  tierOblast: (v: number) => number,
  tierRegion: (v: number) => number,
): number {
  if (!entity) return 0;
  return group === 'region' ? tierRegion(entity.valueEur) : tierOblast(entity.valueEur);
}

// A geometry shape (a NUTS3 oblast in oblast mode, a NUTS2 район in район mode) is highlighted when
// its own id equals the mode's active key — a direct id-equality check. Each район is its own shape
// now, so there is no more "does this oblast share the hovered район" cross-referencing.
export function isActiveShape(shapeKey: string, activeKey: string | null): boolean {
  return shapeKey === activeKey;
}

// Click/tap target for the *pinned* selection, given the currently selected key (a nuts3 in oblast
// mode, a nuts2 in район mode — the toggle semantics are identical either way). A click always
// toggles the pin the same way on fine and coarse pointers alike: clicking the already-pinned shape
// deselects it, clicking a different (or previously unselected) shape moves the pin there. Unlike
// hover, `selected` only ever changes on click — never on mouseenter/mouseleave — so there is no
// fine/coarse pointer ambiguity to resolve here the way the old hover-as-selection code needed.
export function nextSelected(key: string | undefined, selected: string | null): string | null {
  if (!key) return selected;
  if (selected === key) return null;
  return key;
}

// The resolved active key driving the card + highlight: a pin always wins over a transient hover,
// so leaving the map (which clears `hovered`) never empties a pinned card.
export function resolveActiveKey(selected: string | null, hovered: string | null): string | null {
  return selected ?? hovered;
}

// Selection carried across the области/райони mode toggle. Switching to район mode carries the
// pinned oblast's own район forward (so the card keeps showing the district the user already
// pinned, per today's UX); switching to oblast mode clears the selection outright — there is no
// single implied oblast to fall back to from a pinned район, so guessing one would be wrong.
export function onGroupSwitch(
  newGroup: Grouping,
  selectedOblast: string | null,
  byNuts3: Map<string, RegionSpend>,
): { selectedOblast: string | null; selectedRegion: string | null } {
  if (newGroup === 'oblast') return { selectedOblast: null, selectedRegion: null };
  return {
    selectedOblast,
    selectedRegion: selectedOblast ? (byNuts3.get(selectedOblast)?.nuts2 ?? null) : null,
  };
}

// Top-3-bidders list for the Information Card, only meaningful at oblast (NUTS3) level — a район
// aggregates several oblasts, so there is no single "region total" a район-level share would be
// against. Undefined in район mode, when nothing is hovered/selected, or when the loader has no
// entry for that oblast (e.g. it had no attributed bidders at all).
export function activeTopBeneficiaries(
  group: Grouping,
  activeOblast: RegionSpend | null,
  topBeneficiaries: Record<string, RegionTopBeneficiary[]> | undefined,
): RegionTopBeneficiary[] | undefined {
  if (group !== 'oblast' || !activeOblast) return undefined;
  return topBeneficiaries?.[activeOblast.nuts3];
}
