import type { RegionSpend } from '@sigma/api-contract';
import { money } from '@sigma/shared';
import { BG_MAP } from '../lib/bg-region-geometry';

// Static SVG choropleth of the 28 regions, coloured by spend. Same spirit as SankeyDiagram: geometry
// is a committed asset, tiers are computed server-side, no chart JS ships. The accessible data lives
// in the ranked table beside it; the SVG is a visual summary (role="img" + aria-label) with a native
// <title> per region for hover. Sequential oklch ramp (matches the palette in @sigma/config).

const TIER_FILL = [
  'oklch(0.96 0.01 250)', // 0 = no / negligible spend
  'oklch(0.88 0.05 250)',
  'oklch(0.78 0.09 250)',
  'oklch(0.67 0.13 250)',
  'oklch(0.56 0.16 250)',
  'oklch(0.45 0.17 250)', // 5 = highest
];

// Quantile tiers over the non-zero values, so one dominant region (София) does not flatten the rest.
function tierer(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const breaks = [at(0.2), at(0.4), at(0.6), at(0.8)];
  return (v) => (v <= 0 ? 0 : 1 + breaks.filter((b) => v > b).length);
}

export function Choropleth({ regions }: { regions: RegionSpend[] }) {
  const byNuts3 = new Map(regions.map((r) => [r.nuts3, r]));
  const tierOf = tierer(regions.map((r) => r.valueEur));

  return (
    <div className="map-wrap">
      <svg
        viewBox={BG_MAP.viewBox}
        role="img"
        aria-label="Карта на България: разходи за обществени поръчки по области"
      >
        {BG_MAP.regions.map((shape) => {
          const r = byNuts3.get(shape.nuts3);
          const tier = r ? tierOf(r.valueEur) : 0;
          return (
            <path key={shape.nuts3} d={shape.d} style={{ fill: TIER_FILL[tier] }}>
              <title>{r ? `${r.name}: ${money(r.valueEur)}` : shape.nuts3}</title>
            </path>
          );
        })}
      </svg>
      <div className="map-legend" aria-hidden="true">
        <span>по-малко</span>
        {TIER_FILL.slice(1).map((fill, i) => (
          <span key={i} className="swatch" style={{ background: fill }} />
        ))}
        <span>повече</span>
      </div>
    </div>
  );
}
