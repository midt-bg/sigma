import type { SankeyLayout } from '@sigma/api-contract';
import { money } from '@sigma/shared';

// Renders the loader-computed Sankey as a static SVG (no chart JS). Authority bars (left) → company
// bars (right), ribbon thickness ∝ flow value. Scrolls horizontally on narrow screens (.flow-scroll)
// rather than shrinking labels into illegibility. Paired with the top-N table for the actual links.
export function SankeyDiagram({ layout }: { layout: SankeyLayout }) {
  return (
    <>
      <p className="flow-scroll-hint">Плъзни хоризонтално, за да видиш цялата схема →</p>
      <div className="flow-scroll">
        <svg
          className="flow-svg"
          viewBox={layout.viewBox}
          role="img"
          aria-label="Поток на средства от институции към компании"
        >
          <text
            x="135"
            y="12"
            textAnchor="end"
            className="cap"
            style={{ fontSize: 11, fontWeight: 700 }}
          >
            Институции
          </text>
          <text x="565" y="12" className="cap" style={{ fontSize: 11, fontWeight: 700 }}>
            Компании
          </text>

          <g fillRule="evenodd">
            {layout.ribbons.map((r, i) => (
              <path className="link" d={r.d} key={i}>
                <title>{r.title}</title>
              </path>
            ))}
          </g>

          {layout.nodes.map((n, i) => {
            const isAuth = n.side === 'authority';
            const tx = isAuth ? n.x - 6 : n.x + n.width + 8;
            return (
              <g key={i}>
                <rect
                  className={`node ${n.side}`}
                  x={n.x}
                  y={n.y}
                  width={n.width}
                  height={n.height}
                >
                  <title>{`${n.label}: ${money(n.valueEur)}`}</title>
                </rect>
                {n.height >= 14 && (
                  <>
                    <text
                      x={tx}
                      y={n.labelY - 1}
                      textAnchor={isAuth ? 'end' : 'start'}
                      className="node-label"
                      style={{ fontWeight: 700 }}
                    >
                      {n.label}
                    </text>
                    <text
                      x={tx}
                      y={n.labelY + 13}
                      textAnchor={isAuth ? 'end' : 'start'}
                      className="node-label small"
                    >
                      {money(n.valueEur)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}
