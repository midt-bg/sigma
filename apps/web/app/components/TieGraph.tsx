import { Link } from 'react-router';
import type { CompanyTieEdge, CompanyTieKind } from '@sigma/api-contract';
import { count, money } from '@sigma/shared';
import type { TieLayout, TieLayoutEdge, TieLayoutNode } from '../lib/tie-layout';
import { roleSentence } from '../lib/registry-roles';
import { personName } from '../lib/person-name';

// The tie graph, drawn as a flowchart: boxes with the name inside and what the tie is written on each edge,
// in a layered layout computed on the server (lib/tie-layout.server.ts). Static SVG, no chart code in the
// browser — same approach as NetworkGraph and SankeyDiagram.
//
// This is a different graph from `NetworkGraph`, not a restyle of it. That one draws `flow_pairs`: an
// authority ⇄ winner money flow with no company↔company edge in it at all. Here the edge — not the node —
// carries the meaning:
//
//   consortium     solid       joint bidding: both are named members of the same обединение that won
//   subcontract    dashed →    one was recorded as the other's subcontractor (directed, prime → sub)
//   declared_stake dotted      the same office-holder declared an interest in both
//   role           thin        a role the Trade Register records: a person (a rounded box) or a company
//                              holds it at the company it points to; faded once every such role has ended
//   money          hairline →  an institution that paid the centre (context layer)
//
// A declared-stake office-holder is identified on the company-to-company edge and in its source links.
// The people drawn as nodes are the ones the Trade Register records in a role, named
// as it names them, each linking to their page (ADR-0039).

const TIE_LABEL: Record<CompanyTieKind, string> = {
  consortium: 'съвместно изпълнение',
  subcontract: 'подизпълнител',
  declared_stake: 'общо свързано лице',
  role: 'роля по Търговския регистър',
  money: 'плаща на',
};

/** How an edge is described in words — the accessible table and the tooltip use the same sentence. */
export function tieDescription(e: CompanyTieEdge): string {
  if (e.kind === 'role') return roleSentence(e);
  if (e.kind === 'money') return `${TIE_LABEL.money} ${money(e.weightEur)}`;
  if (e.kind === 'declared_stake') {
    if (e.people?.length)
      return `Общ деклариран интерес: ${e.people.map((p) => personName(p.name)).join(', ')}`;
    return e.occurrences > 1
      ? `${TIE_LABEL.declared_stake} — ${count(e.occurrences)} лица`
      : TIE_LABEL.declared_stake;
  }
  if (e.kind === 'consortium')
    return `${TIE_LABEL.consortium} — ${count(e.occurrences)} ${e.occurrences === 1 ? 'състав' : 'състава'} изпълнители, ${money(e.weightEur)} обща стойност на договорите`;
  const n = e.occurrences > 1 ? ` — ${count(e.occurrences)} пъти` : '';
  return `${TIE_LABEL[e.kind]}${n}, ${money(e.weightEur)}`;
}

const KIND_WORD: Record<TieLayoutNode['kind'], string> = {
  company: 'участник',
  authority: 'институция',
  person: 'лице',
};

// A person wins nothing, so a person's box is never labelled with a sum.
const nodeTitle = (n: TieLayoutNode) =>
  n.kind === 'person' ? personName(n.name) : `${n.name}: ${money(n.valueEur)}`;
const nodeAria = (n: TieLayoutNode) =>
  n.kind === 'person'
    ? `${personName(n.name)} — ${KIND_WORD.person}`
    : `${n.name} — ${KIND_WORD[n.kind]}, ${money(n.valueEur)}`;

const pathD = (e: TieLayoutEdge) =>
  e.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

export function TieGraph({ layout }: { layout: TieLayout | null }) {
  if (!layout) return null;
  const { width, height, nodes, edges } = layout;
  // Only monetary ties are sized by money; a declared-stake or a role tie has no sum and must not be drawn
  // as if it were worth nothing — each gets a fixed, clearly visible weight instead.
  const maxEdge = Math.max(1, ...edges.map((e) => e.weightEur));
  const strokeW = (e: TieLayoutEdge) =>
    e.kind === 'declared_stake' ? 2 : e.kind === 'role' ? 1.5 : 1 + (e.weightEur / maxEdge) * 3;
  const past = (e: TieLayoutEdge) => e.kind === 'role' && e.current === false;

  return (
    <>
      <div className="flow-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`Връзки на ${nodes.some((n) => n.center && n.kind === 'person') ? personName(layout.centerName) : layout.centerName}`}
          className="tie-svg"
          // Never drawn larger than laid out (a small graph must not balloon), and on a narrow screen kept
          // legible and scrolled rather than shrunk.
          style={{ maxWidth: width, minWidth: Math.min(width, 640) }}
        >
          <defs>
            <marker
              id="tie-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              // A fixed size, not one that grows with the stroke: a heavy money edge must not carry a
              // head larger than the box it points at.
              markerUnits="userSpaceOnUse"
              markerWidth="9"
              markerHeight="9"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="tie-arrow-head" />
            </marker>
          </defs>
          {edges.map((e, i) => (
            <g key={`e${i}`}>
              <path
                className={`tie-edge tie-${e.kind}${past(e) ? ' tie-past' : ''}`}
                d={pathD(e)}
                style={{ strokeWidth: strokeW(e) }}
                markerEnd={e.directed ? 'url(#tie-arrow)' : undefined}
              >
                <title>{tieDescription(e)}</title>
              </path>
              {/* A paper plate under the words, so a dashed or dotted line never shows through them. */}
              <rect
                className="tie-edge-plate"
                x={e.label.x - e.label.width / 2}
                y={e.label.y - 7}
                width={e.label.width}
                height={14}
                aria-hidden="true"
              />
              <text
                className="tie-edge-label"
                x={e.label.x}
                y={e.label.y + 3}
                textAnchor="middle"
                aria-hidden="true"
              >
                {e.kind === 'declared_stake' && e.people?.length === 1
                  ? personName(e.label.text)
                  : e.label.text}
              </text>
            </g>
          ))}
          {nodes.map((n) => (
            <Link key={n.id} to={n.href} className="tie-node-link" aria-label={nodeAria(n)}>
              <title>{nodeTitle(n)}</title>
              <rect
                className={`tie-node${n.kind === 'authority' ? ' tie-node-authority' : ''}${n.kind === 'person' ? ' tie-node-person' : ''}${n.center ? ' tie-node-center' : ''}`}
                x={n.x - n.width / 2}
                y={n.y - n.height / 2}
                width={n.width}
                height={n.height}
                rx={n.kind === 'person' ? n.height / 2 : n.kind === 'authority' ? 10 : 3}
              />
              <text className="tie-node-label" x={n.x} y={n.y + 4} textAnchor="middle">
                {n.kind === 'person' ? personName(n.label) : n.label}
              </text>
            </Link>
          ))}
        </svg>
      </div>
      {edges.some((e) => e.people?.length) && (
        <div className="graph-evidence">
          <p className="small muted">Общи декларатори — източници и профили:</p>
          <ul>
            {edges
              .filter((e) => e.people?.length)
              .map((e) => (
                <li key={`${e.from}-${e.to}`}>
                  <span>
                    {nodes.find((n) => n.id === e.from)?.name} ·{' '}
                    {nodes.find((n) => n.id === e.to)?.name}:{' '}
                  </span>
                  {e.people!.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && '; '}
                      <Link to={p.href}>{personName(p.name)}</Link>
                    </span>
                  ))}
                </li>
              ))}
          </ul>
        </div>
      )}
      <ul className="tie-legend" aria-hidden="true">
        {(['consortium', 'subcontract', 'declared_stake', 'role'] as const)
          .filter((k) => edges.some((e) => e.kind === k))
          .map((k) => (
            <li key={k}>
              <span className={`tie-key tie-${k}`} /> {TIE_LABEL[k]}
            </li>
          ))}
        {edges.some(past) && (
          <li>
            <span className="tie-key tie-role tie-past" /> прекратена роля
          </li>
        )}
        {edges.some((e) => e.kind === 'money') && (
          <li>
            <span className="tie-key tie-money" /> институция платец
          </li>
        )}
      </ul>
    </>
  );
}
