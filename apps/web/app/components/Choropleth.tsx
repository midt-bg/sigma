import { useState } from 'react';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import { count, money, pct } from '@sigma/shared';
import { BG_MAP } from '../lib/bg-region-geometry';

// Static SVG choropleth of the 28 regions, coloured by spend. Same spirit as SankeyDiagram: geometry
// is a committed asset, tiers are computed server-side, no chart JS ships. The accessible data lives
// in the ranked table beside it; the SVG is a visual summary (role="img" + aria-label) with a native
// <title> per region for hover (the no-JS fallback). Sequential monochrome ramp from --paper to --ink
// (palette tokens, no off-palette blue or green), matching the site's ink-based viz language.
//
// Progressive enhancement: with JS, hovering a region fills an Information Card beside the map (not an
// overlay) with that zone's summary stats — the same figures the ranked tables list — and a toggle in
// the card switches the colouring/grouping between oblasts (NUTS3) and planning regions (NUTS2, each a
// group of oblasts). No JS → the native <title> tooltip still works and the card shows its prompt.
const TIER_FILL = [
  'color-mix(in oklch, var(--ink) 8%, var(--paper))', // 0 = no / negligible spend
  'color-mix(in oklch, var(--ink) 26%, var(--paper))',
  'color-mix(in oklch, var(--ink) 44%, var(--paper))',
  'color-mix(in oklch, var(--ink) 62%, var(--paper))',
  'color-mix(in oklch, var(--ink) 80%, var(--paper))',
  'var(--ink)', // 5 = highest
];

// Quantile tiers over the non-zero values, so one dominant zone (София) does not flatten the rest.
function tierer(values: number[]): (v: number) => number {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const breaks = [at(0.2), at(0.4), at(0.6), at(0.8)];
  return (v) => (v <= 0 ? 0 : 1 + breaks.filter((b) => v > b).length);
}

type Grouping = 'oblast' | 'region';

// `total` enables the Information Card + grouping toggle (the /map page passes it, along with
// macroRegions). Omitted on the compact analytics-hub preview, where only the bare oblast map is wanted.
export function Choropleth({
  regions,
  macroRegions = [],
  total,
}: {
  regions: RegionSpend[];
  macroRegions?: MacroRegionSpend[];
  total?: number;
}) {
  const byNuts3 = new Map(regions.map((r) => [r.nuts3, r]));
  const macroByNuts2 = new Map(macroRegions.map((m) => [m.nuts2, m]));
  const tierOblast = tierer(regions.map((r) => r.valueEur));
  const tierRegion = tierer(macroRegions.map((m) => m.valueEur));

  const withCard = total != null;
  const [group, setGroup] = useState<Grouping>('oblast');
  const [hovered, setHovered] = useState<string | null>(null); // always a nuts3 (the geometry unit)

  const hoveredRegion = hovered ? (byNuts3.get(hovered) ?? null) : null;
  const hoveredMacro = hoveredRegion ? (macroByNuts2.get(hoveredRegion.nuts2) ?? null) : null;
  // The entity whose stats the card shows, by mode.
  const active = withCard ? (group === 'region' ? hoveredMacro : hoveredRegion) : null;

  // Tier (colour) for a geometry path, by mode: its own oblast value, or its parent район's value.
  const tierForShape = (r: RegionSpend | undefined): number => {
    if (!r) return 0;
    if (group === 'region') return tierRegion(macroByNuts2.get(r.nuts2)?.valueEur ?? 0);
    return tierOblast(r.valueEur);
  };
  // A path is highlighted when it's the hovered oblast (oblast mode) or shares the hovered район (region mode).
  const isActiveShape = (r: RegionSpend | undefined): boolean => {
    if (!r || !hoveredRegion) return false;
    return group === 'region' ? r.nuts2 === hoveredRegion.nuts2 : r.nuts3 === hoveredRegion.nuts3;
  };

  const map = (
    <div className="map-wrap">
      <svg
        viewBox={BG_MAP.viewBox}
        role="img"
        aria-label="Карта на България: разходи за обществени поръчки по области"
        onMouseLeave={() => setHovered(null)}
      >
        {BG_MAP.regions.map((shape) => {
          const r = byNuts3.get(shape.nuts3);
          const label =
            group === 'region' && r
              ? `${r.nuts2Name}: ${money(macroByNuts2.get(r.nuts2)?.valueEur ?? 0)}`
              : r
                ? `${r.name}: ${money(r.valueEur)}`
                : shape.nuts3;
          return (
            <path
              key={shape.nuts3}
              d={shape.d}
              className={isActiveShape(r) ? 'region is-active' : 'region'}
              style={{ fill: TIER_FILL[tierForShape(r)] }}
              onMouseEnter={() => setHovered(r ? shape.nuts3 : null)}
            >
              <title>{label}</title>
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

  if (!withCard) return map;

  return (
    <div className="map-layout">
      {map}
      {/* Information Card beside the map (not an overlay), with the grouping toggle kept here so all map
          controls sit together. aria-live announces the stats as the pointer moves; the ranked tables
          below remain the primary accessible/keyboard data path. */}
      <aside className="map-card">
        <div className="map-toggle" role="group" aria-label="Групиране на картата">
          <button
            type="button"
            className={group === 'oblast' ? 'is-on' : undefined}
            aria-pressed={group === 'oblast'}
            onClick={() => setGroup('oblast')}
          >
            По области
          </button>
          <button
            type="button"
            className={group === 'region' ? 'is-on' : undefined}
            aria-pressed={group === 'region'}
            onClick={() => setGroup('region')}
          >
            По райони
          </button>
        </div>
        <div aria-live="polite">
          {active ? (
            <>
              <h3 className="map-card-title">{active.name}</h3>
              {group === 'oblast' && hoveredRegion && (
                <p className="map-card-sub muted">Район: {hoveredRegion.nuts2Name}</p>
              )}
              <dl className="map-card-stats">
                <div>
                  <dt>Стойност</dt>
                  <dd>{money(active.valueEur)}</dd>
                </div>
                <div>
                  <dt>Дял от всички области</dt>
                  <dd>{pct(total && total > 0 ? active.valueEur / total : 0)}</dd>
                </div>
                <div>
                  <dt>Договори</dt>
                  <dd>{count(active.contracts)}</dd>
                </div>
                {group === 'oblast' && hoveredRegion && (
                  <div>
                    <dt>Институции</dt>
                    <dd>{count(hoveredRegion.authorities)}</dd>
                  </div>
                )}
              </dl>
            </>
          ) : (
            <p className="map-card-hint muted">
              {group === 'region'
                ? 'Посочи район на картата, за да видиш обобщени данни.'
                : 'Посочи област на картата, за да видиш обобщени данни.'}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
