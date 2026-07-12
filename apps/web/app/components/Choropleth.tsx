import { useEffect, useState } from 'react';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import type { RegionTopBeneficiary } from '@sigma/db';
import { count, money, pct } from '@sigma/shared';
import { BG_MAP } from '../lib/bg-region-geometry';
import {
  activeTopBeneficiaries,
  type Grouping,
  isActiveShape,
  nextSelected,
  resolveActiveKey,
  shareLabel,
  shareOfTotal,
  tierer,
  tierForShape,
} from '../lib/choropleth';

// Static SVG choropleth of the 28 regions, coloured by spend. Same spirit as SankeyDiagram: geometry
// is a committed asset, tiers are computed server-side, no chart JS ships. The accessible data lives
// in the ranked table beside it; the SVG is a visual summary (role="img" + aria-label) with a native
// <title> per region for hover (the no-JS fallback). Sequential monochrome ramp from --paper to --ink
// (palette tokens, no off-palette blue or green), matching the site's ink-based viz language.
//
// Progressive enhancement: with JS, hovering (or tapping, since touch screens never fire
// onMouseEnter) a region fills an Information Card beside the map (not an overlay) with that
// zone's summary stats — the same figures the ranked tables list — and a toggle in the card
// switches the colouring/grouping between oblasts (NUTS3) and planning regions (NUTS2, each a
// group of oblasts). No JS → the native <title> tooltip still works and the card shows its prompt.
const TIER_FILL = [
  'color-mix(in oklch, var(--ink) 8%, var(--paper))', // 0 = no / negligible spend
  'color-mix(in oklch, var(--ink) 26%, var(--paper))',
  'color-mix(in oklch, var(--ink) 44%, var(--paper))',
  'color-mix(in oklch, var(--ink) 62%, var(--paper))',
  'color-mix(in oklch, var(--ink) 80%, var(--paper))',
  'var(--ink)', // 5 = highest
];

// How long a hover has to sit still before the aria-live region announces it. Mouse hover fires on
// every pixel the cursor crosses; without this, a single sweep across the map reads out every region
// it passed. The visible Information Card still updates instantly — only the screen-reader announcement
// is throttled, since the ranked table below remains the primary keyboard/AT path.
const ANNOUNCE_DEBOUNCE_MS = 400;

// `total` enables the Information Card + grouping toggle (the /map page passes it, along with
// macroRegions). Omitted on the compact analytics-hub preview, where only the bare oblast map is wanted.
export function Choropleth({
  regions,
  macroRegions = [],
  total,
  topBeneficiaries,
}: {
  regions: RegionSpend[];
  macroRegions?: MacroRegionSpend[];
  total?: number;
  topBeneficiaries?: Record<string, RegionTopBeneficiary[]>;
}) {
  const byNuts3 = new Map(regions.map((r) => [r.nuts3, r]));
  const macroByNuts2 = new Map(macroRegions.map((m) => [m.nuts2, m]));
  const tierOblast = tierer(regions.map((r) => r.valueEur));
  const tierRegion = tierer(macroRegions.map((m) => m.valueEur));

  const withCard = total != null;
  const [group, setGroup] = useState<Grouping>('oblast');
  const [hovered, setHovered] = useState<string | null>(null); // transient preview, always a nuts3
  // The pinned selection (also a nuts3), distinct from `hovered` — set only by click/tap, so it
  // survives the cursor leaving the map (unlike hover, which clears on mouseleave).
  const [selected, setSelected] = useState<string | null>(null);
  // The grouping toggle only does anything with JS (it flips client state), so render it only after
  // hydration — otherwise no-JS users get a real-looking but inert control. The no-JS map stays in the
  // default „области" colouring, which is what the static aria-label below describes.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Selection always wins over hover — see resolveActiveKey. Everything below (card content, top
  // beneficiaries, highlight) derives from this resolved key, never from `hovered` directly.
  const activeKey = resolveActiveKey(selected, hovered);
  const activeRegion = activeKey ? (byNuts3.get(activeKey) ?? null) : null;
  const activeMacro = activeRegion ? (macroByNuts2.get(activeRegion.nuts2) ?? null) : null;
  // The entity whose stats the card shows, by mode.
  const active = withCard ? (group === 'region' ? activeMacro : activeRegion) : null;

  // Debounced echo of `active`, read out by the sr-only aria-live region below — see
  // ANNOUNCE_DEBOUNCE_MS. The visible card renders `active` directly, with no delay.
  const [announced, setAnnounced] = useState<typeof active>(null);
  useEffect(() => {
    const id = setTimeout(() => setAnnounced(active), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [active]);

  const map = (
    <div className="map-wrap">
      <svg
        viewBox={BG_MAP.viewBox}
        role="img"
        aria-label={`Карта на България: разходи за обществени поръчки по ${
          group === 'region' ? 'райони' : 'области'
        }`}
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
              className={isActiveShape(r, activeRegion, group) ? 'region is-active' : 'region'}
              style={{
                fill: TIER_FILL[tierForShape(r, group, macroByNuts2, tierOblast, tierRegion)],
              }}
              aria-current={r && r.nuts3 === activeKey ? 'true' : undefined}
              onMouseEnter={() => setHovered(r ? shape.nuts3 : null)}
              onClick={() => setSelected(nextSelected(r ? shape.nuts3 : undefined, selected))}
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
          controls sit together. The visible card updates instantly; a debounced sr-only region below
          announces it so a mouse sweep across the map doesn't read out every region it passed — the
          ranked tables below remain the primary accessible/keyboard data path. */}
      <aside className={selected ? 'map-card map-card--pinned' : 'map-card'}>
        {hydrated && selected && (
          <button
            type="button"
            className="map-card-dismiss"
            aria-label="Затвори картата с данни"
            onClick={() => {
              setSelected(null);
              // Also clear the transient hover: some touch browsers synthesize mouseenter/click but
              // never fire mouseleave on tap, so `hovered` can be left pinned to the last-tapped
              // shape — without this, resolveActiveKey would fall straight back to that stale value
              // and the dismiss button would appear to do nothing.
              setHovered(null);
            }}
          >
            ✕
          </button>
        )}
        {hydrated && (
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
        )}
        <div>
          {active ? (
            <>
              <h3 className="map-card-title">{active.name}</h3>
              {group === 'oblast' && activeRegion && (
                <p className="map-card-sub muted">Район: {activeRegion.nuts2Name}</p>
              )}
              <dl className="map-card-stats">
                <div>
                  <dt>Стойност</dt>
                  <dd>{money(active.valueEur)}</dd>
                </div>
                <div>
                  <dt>{shareLabel(group)}</dt>
                  <dd>{pct(shareOfTotal(active.valueEur, total))}</dd>
                </div>
                <div>
                  <dt>Договори</dt>
                  <dd>{count(active.contracts)}</dd>
                </div>
                {group === 'oblast' && activeRegion && (
                  <div>
                    <dt>Институции</dt>
                    <dd>{count(activeRegion.authorities)}</dd>
                  </div>
                )}
              </dl>
              <TopBeneficiaries
                list={activeTopBeneficiaries(group, activeRegion, topBeneficiaries)}
              />
            </>
          ) : (
            <p className="map-card-hint muted">
              {group === 'region'
                ? 'Посочи район на картата, за да видиш обобщени данни.'
                : 'Посочи област на картата, за да видиш обобщени данни.'}
            </p>
          )}
        </div>
        <p className="sr-only" aria-live="polite">
          {announced
            ? `${announced.name}: ${money(announced.valueEur)}`
            : group === 'region'
              ? 'Посочи район на картата, за да видиш обобщени данни.'
              : 'Посочи област на картата, за да видиш обобщени данни.'}
        </p>
      </aside>
    </div>
  );
}

// Top 3 bidder companies by awarded value in the active oblast, with each one's share of the
// region's total value. Only meaningful at oblast (NUTS3) level, not aggregated across a район.
function TopBeneficiaries({ list }: { list?: RegionTopBeneficiary[] }) {
  if (!list || list.length === 0) return null;
  return (
    <div className="map-card-top">
      <p className="map-card-top-title muted">Топ 3 бенефициенти</p>
      <ul>
        {list.map((b) => (
          <li key={b.bidderId}>
            <span className="map-card-top-name">{b.name}</span>
            <span className="map-card-top-share">{pct(b.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
