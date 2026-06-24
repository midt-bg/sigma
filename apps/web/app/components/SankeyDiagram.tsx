import type { SankeyLayout, SankeyNode } from '@sigma/api-contract';
import { money } from '@sigma/shared';

// A node may carry a drill-down target (`/authorities/:slug` or `/companies/:slug`) so the bar +
// label become a real link. Optional so the component still renders if the loader omits it.
type LinkedNode = SankeyNode & { href?: string };

// Renders the loader-computed Sankey as a static SVG (no chart JS). Authority bars (left) → company
// bars (right), ribbon thickness ∝ flow value. Scrolls horizontally on narrow screens (.flow-scroll)
// rather than shrinking labels into illegibility. Paired with the top-N table for the actual links.
export function SankeyDiagram({ layout }: { layout: SankeyLayout }) {
  // The loader lays the geometry out in a fixed user-space height (sized for the Top-20 view), so
  // the „Топ 50" view (≈35 bars/side) crams its bars and collides labels. Stretch the geometry
  // vertically by the column count — bars + gaps grow, labels keep their font size — and grow the
  // viewBox to match so width still flexes to the container without horizontal distortion.
  const perSide = Math.max(
    layout.nodes.filter((n) => n.side === 'authority').length,
    layout.nodes.filter((n) => n.side === 'company').length,
  );
  const vScale = Math.max(1, perSide / 20);
  // viewBox is "minX minY width height"; stretch only the height to match the vertical scale.
  const viewBoxParts = layout.viewBox.split(/\s+/).filter(Boolean).map(Number);
  const [vbX, vbY, vbW, vbH] =
    viewBoxParts.length === 4 && viewBoxParts.every(Number.isFinite)
      ? viewBoxParts
      : [0, 0, 700, layout.height];
  const viewBox = `${vbX} ${vbY} ${vbW} ${(vbH * vScale).toFixed(0)}`;

  return (
    <>
      <p className="flow-scroll-hint">Плъзни настрани, за да видиш цялата схема →</p>
      <div className="flow-scroll">
        <svg
          className="flow-svg"
          viewBox={viewBox}
          role="img"
          aria-label="Поток на средства от институции към компании"
        >
          <text x="135" y="12" textAnchor="end" className="cap">
            Институции
          </text>
          <text x="565" y="12" className="cap">
            Компании
          </text>

          <g fillRule="evenodd" transform={vScale === 1 ? undefined : `scale(1 ${vScale})`}>
            {layout.ribbons.map((r) => (
              <path className="link" d={r.d} key={`${r.fromName}-${r.toName}-${r.valueEur}`}>
                <title>{r.title}</title>
              </path>
            ))}
          </g>

          {(layout.nodes as LinkedNode[]).map((n) => {
            const isAuth = n.side === 'authority';
            const tx = isAuth ? n.x - 6 : n.x + n.width + 8;
            // Stretch bar geometry + label baseline vertically (font size stays put for legibility).
            const y = n.y * vScale;
            const height = n.height * vScale;
            const labelY = n.labelY * vScale;
            // Two-line label needs ~26 user units of bar height to clear its neighbour; below that
            // we drop the label (the hover tooltip still carries the name + value).
            const showLabel = height >= 26;
            const kind = isAuth ? 'институция' : 'компания';
            const body = (
              <>
                <rect className={`node ${n.side}`} x={n.x} y={y} width={n.width} height={height}>
                  <title>{`${n.label}: ${money(n.valueEur)}`}</title>
                </rect>
                {showLabel && (
                  <>
                    <text
                      x={tx}
                      y={labelY - 1}
                      textAnchor={isAuth ? 'end' : 'start'}
                      className="node-label is-name"
                    >
                      {n.label}
                    </text>
                    <text
                      x={tx}
                      y={labelY + 13}
                      textAnchor={isAuth ? 'end' : 'start'}
                      className="node-label small"
                    >
                      {money(n.valueEur)}
                    </text>
                  </>
                )}
              </>
            );
            return n.href ? (
              <a
                key={`${n.side}-${n.label}-${n.x}-${n.y}`}
                href={n.href}
                className="node-link"
                aria-label={`${n.label} (${kind}): ${money(n.valueEur)}`}
              >
                {body}
              </a>
            ) : (
              <g key={`${n.side}-${n.label}-${n.x}-${n.y}`}>{body}</g>
            );
          })}
        </svg>
      </div>
    </>
  );
}
