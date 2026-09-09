import { Link } from 'react-router';
import type { CompanyTieEdge, CompanyTieKind, CompanyTieNetwork } from '@sigma/api-contract';
import { count, money } from '@sigma/shared';

// The company tie graph: the centre company and the companies it is tied to, with the KIND
// of tie drawn on the edge. Static server-rendered SVG, no chart library — same approach as NetworkGraph
// and SankeyDiagram.
//
// This is a different graph from `NetworkGraph`, not a restyle of it. That one draws `flow_pairs`: an
// authority ⇄ winner money flow with no company↔company edge in it at all. Here the edges ARE between
// companies, and the edge — not the node — carries the meaning:
//
//   consortium     solid       joint bidding: both are named members of the same обединение that won
//   subcontract    dashed →    one was recorded as the other's subcontractor (directed, prime → sub)
//   declared_stake dotted      the same office-holder declared an interest in both
//   money          hairline →  an institution that paid the centre (context layer, off by default)
//
// PRIVACY: a person is never a node here and never named. The shared-official tie is drawn between the two
// COMPANIES and links to /conflicts, the noindex surface where that name is already published under the
// LIA. The company profile is indexed, so it gains no personal name from this graph (ADR-0010).

const W = 760;
const H = 520;
const CX = W / 2;
const CY = H / 2;
const R = 190;

const TIE_LABEL: Record<CompanyTieKind, string> = {
  consortium: 'общо обединение',
  subcontract: 'подизпълнител',
  declared_stake: 'общо свързано лице',
  money: 'плаща на',
};

function truncate(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** How an edge is described in words — the accessible table and the tooltip use the same sentence. */
export function tieDescription(e: CompanyTieEdge): string {
  if (e.kind === 'money') return `${TIE_LABEL.money} ${money(e.weightEur)}`;
  if (e.kind === 'declared_stake') {
    return e.occurrences > 1
      ? `${TIE_LABEL.declared_stake} — ${count(e.occurrences)} лица`
      : TIE_LABEL.declared_stake;
  }
  const n = e.occurrences > 1 ? ` — ${count(e.occurrences)} пъти` : '';
  return `${TIE_LABEL[e.kind]}${n}, ${money(e.weightEur)}`;
}

export function TieGraph({ data }: { data: CompanyTieNetwork }) {
  const { center, nodes, edges } = data;
  if (!center || nodes.length < 2) return null;

  const ring = nodes.filter((n) => n.id !== center.id);
  const pos = new Map<string, { x: number; y: number }>([[center.id, { x: CX, y: CY }]]);
  ring.forEach((n, i) => {
    const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.id, { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R * 0.82 });
  });

  const maxVal = Math.max(1, ...nodes.map((n) => n.valueEur));
  const radius = (v: number) => 7 + Math.sqrt(Math.max(0, v) / maxVal) * 20;
  // Only monetary ties are sized by money; a declared-stake tie has no sum and must not be drawn as if
  // it were worth nothing — it gets a fixed, clearly visible weight instead.
  const maxEdge = Math.max(1, ...edges.map((e) => e.weightEur));
  const strokeW = (e: CompanyTieEdge) =>
    e.kind === 'declared_stake' ? 2 : 1 + (e.weightEur / maxEdge) * 4;

  return (
    <>
      <div className="flow-scroll">
        <svg
          viewBox={`-110 -10 ${W + 220} ${H + 20}`}
          role="group"
          aria-label={`Връзки на ${center.label} с други дружества`}
          className="tie-svg"
        >
          <defs>
            <marker
              id="tie-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="tie-arrow-head" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={`e${i}`}
                className={`tie-edge tie-${e.kind}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                style={{ strokeWidth: strokeW(e) }}
                markerEnd={e.directed ? 'url(#tie-arrow)' : undefined}
              >
                <title>{tieDescription(e)}</title>
              </line>
            );
          })}
          {nodes.map((n) => {
            const pt = pos.get(n.id);
            if (!pt) return null;
            const r = radius(n.valueEur);
            const right = pt.x >= CX;
            const isCenter = n.id === center.id;
            const href = n.kind === 'authority' ? `/authorities/${n.slug}` : `/companies/${n.slug}`;
            return (
              <Link
                key={n.id}
                to={href}
                className="tie-node-link"
                aria-label={`${n.label} — ${n.kind === 'authority' ? 'институция' : 'дружество'}, ${money(n.valueEur)}`}
              >
                <title>{`${n.label}: ${money(n.valueEur)}`}</title>
                {n.kind === 'authority' ? (
                  <circle className="tie-node tie-node-authority" cx={pt.x} cy={pt.y} r={r} />
                ) : (
                  <rect
                    className={`tie-node${isCenter ? ' tie-node-center' : ''}`}
                    x={pt.x - r}
                    y={pt.y - r}
                    width={r * 2}
                    height={r * 2}
                    rx={3}
                  />
                )}
                {!isCenter && (
                  <text
                    className="tie-node-label"
                    x={right ? pt.x + r + 5 : pt.x - r - 5}
                    y={pt.y + 4}
                    textAnchor={right ? 'start' : 'end'}
                  >
                    {truncate(n.label)}
                  </text>
                )}
              </Link>
            );
          })}
        </svg>
      </div>
      <ul className="tie-legend" aria-hidden="true">
        {(['consortium', 'subcontract', 'declared_stake'] as const)
          .filter((k) => edges.some((e) => e.kind === k))
          .map((k) => (
            <li key={k}>
              <span className={`tie-key tie-${k}`} /> {TIE_LABEL[k]}
            </li>
          ))}
        {edges.some((e) => e.kind === 'money') && (
          <li>
            <span className="tie-key tie-money" /> институция платец
          </li>
        )}
      </ul>
    </>
  );
}
