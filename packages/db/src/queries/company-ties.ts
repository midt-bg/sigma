// The tie network around one company — who a company is connected to, and how.
//
// The profile graph used to draw `flow_pairs` only: authority ⇄ winner, i.e. money and nothing else, with
// no company↔company edge in it at all. The question a reader brings to a company profile is „who is this
// company tied to", and three kinds of answer are already in the corpus:
//
//   consortium     joint bidding — both are named members of the same обединение that won
//   subcontract    one was recorded as the other's subcontractor
//   declared_stake the same office-holder declared an interest in both
//
// plus the money layer (`flow_pairs`) kept as context: which institutions the money comes from.
//
// The tie edges come precomputed from `company_links` (see migration 0011 + precompute.sql §5b), so this
// is two indexed reads and no string work per request.
//
// PRIVACY: a person is never a node and never named here. A shared official is drawn as an edge BETWEEN
// the two companies, carrying only a link to /conflicts — the noindex surface where that name is already
// published under the LIA. Nothing on the company profile (which IS indexed) gains a personal name.
import type { CompanyTieEdge, CompanyTieNetwork, CompanyTieNode } from '@sigma/api-contract';
import { cleanName, entityName } from '@sigma/shared';
import { SURFACED_OWNERSHIP } from './related-persons';
import { authoritySlug, companySlug } from './identity';

/** Tied companies drawn around the centre. Beyond this the ring stops being readable. */
const MAX_TIES = 8;
/** Paying institutions drawn as the money layer, when asked for. */
const MAX_FUNDERS = 3;

interface LinkRow {
  a_bidder_id: string;
  b_bidder_id: string;
  kind: 'consortium' | 'subcontract' | 'declared_stake';
  directed: number;
  weight_eur: number;
  occurrences: number;
  other_id: string;
  other_name: string;
  other_kind: 'company' | 'consortium';
  other_won_eur: number | null;
  other_conflicts: number;
}

interface FunderRow {
  authority_id: string;
  authority_name: string;
  won_eur: number;
}

interface CenterRow {
  id: string;
  name: string;
  kind: 'company' | 'consortium';
  won_eur: number | null;
  conflicts: number;
}

// A company's surfaced declared-stake links, counted under the exact gate the /conflicts pages publish by
// (SURFACED_OWNERSHIP: published, an ownership class and a Trade Register evidence seal). Counting
// `status = 'published'` alone would offer a /conflicts destination the page itself refuses to render.
const surfacedConflicts = (bidderColumn: string) =>
  `(SELECT COUNT(*) FROM interest_links il WHERE il.bidder_id = ${bidderColumn} AND ${SURFACED_OWNERSHIP})`;

/**
 * One row per tie touching `bidderId`, with the OTHER endpoint resolved. The union covers both storage
 * directions: symmetric ties are stored once with a < b, so a centre can sit on either side.
 *
 * `other_conflicts` counts the other company's published declared-interest links, so the node can offer
 * its /conflicts page without a second query.
 */
const TIES_SQL = `
  WITH tie AS (
    SELECT l.a_bidder_id, l.b_bidder_id, l.kind, l.directed, l.weight_eur, l.occurrences,
           l.b_bidder_id AS other_id
    FROM company_links l WHERE l.a_bidder_id = ?1
    UNION ALL
    SELECT l.a_bidder_id, l.b_bidder_id, l.kind, l.directed, l.weight_eur, l.occurrences,
           l.a_bidder_id AS other_id
    FROM company_links l WHERE l.b_bidder_id = ?1
  )
  SELECT t.a_bidder_id, t.b_bidder_id, t.kind, t.directed, t.weight_eur, t.occurrences,
         t.other_id, b.name AS other_name, b.kind AS other_kind, ct.won_eur AS other_won_eur,
         ${surfacedConflicts('t.other_id')} AS other_conflicts
  FROM tie t
  JOIN bidders b ON b.id = t.other_id
  LEFT JOIN company_totals ct ON ct.bidder_id = t.other_id
  ORDER BY t.weight_eur DESC, t.occurrences DESC, t.other_id`;

const FUNDERS_SQL = `
  SELECT fp.authority_id, fp.authority_name, fp.won_eur
  FROM flow_pairs fp WHERE fp.bidder_id = ?1
  ORDER BY fp.won_eur DESC LIMIT ?2`;

const CENTER_SQL = `
  SELECT b.id, b.name, b.kind, ct.won_eur,
         ${surfacedConflicts('b.id')} AS conflicts
  FROM bidders b LEFT JOIN company_totals ct ON ct.bidder_id = b.id
  WHERE b.id = ?1`;

function companyNode(
  id: string,
  name: string,
  kind: 'company' | 'consortium',
  wonEur: number | null,
  conflicts: number,
  hop: number,
): CompanyTieNode {
  const slug = companySlug(id);
  return {
    id,
    kind: 'company',
    label: entityName(cleanName(name), kind),
    slug,
    valueEur: wonEur ?? 0,
    hop,
    // Only offered when the company actually has a published link — otherwise the reader is sent to a 404,
    // and an empty page under a company's name is exactly what the conflicts surface refuses to render.
    conflictsHref: conflicts > 0 ? `/conflicts/company/${slug}` : null,
  };
}

export interface CompanyTieOptions {
  /** Draw the paying institutions as a second layer („where the money comes from" in the sketch). */
  includeFunders?: boolean;
  maxTies?: number;
}

export async function getCompanyTies(
  db: D1Database,
  bidderId: string,
  opts: CompanyTieOptions = {},
): Promise<CompanyTieNetwork> {
  const maxTies = opts.maxTies ?? MAX_TIES;
  const [centerRes, tieRes] = await Promise.all([
    db.prepare(CENTER_SQL).bind(bidderId).first<CenterRow>(),
    db.prepare(TIES_SQL).bind(bidderId).all<LinkRow>(),
  ]);
  if (!centerRes) return { center: null, nodes: [], edges: [], omitted: 0 };

  const center = companyNode(
    centerRes.id,
    centerRes.name,
    centerRes.kind,
    centerRes.won_eur,
    centerRes.conflicts,
    0,
  );

  // A pair can be tied in more than one way (joint bidders who also subcontract). Keep every tie kind as
  // its own edge — the kinds are different claims and collapsing them would lose the distinction — but
  // rank the NODES by their strongest tie, so a company does not fall off the picture because its
  // second-best tie is weak.
  //
  // Ranked by HOW OFTEN the tie recurs first, and only then by money. The question is „who is this
  // company tied to", and a pairing that recurs is a relationship, while a single large joint contract is
  // an event. Ranking by money alone pushes a pair that has bid together many times below one-off
  // pairings on bigger jobs — the opposite of what the graph is for. It also lets the money-less
  // declared_stake tie compete at all, instead of always sorting last at 0.
  const strongest = new Map<string, { times: number; eur: number }>();
  for (const r of tieRes.results) {
    const prev = strongest.get(r.other_id);
    strongest.set(r.other_id, {
      times: Math.max(prev?.times ?? 0, r.occurrences),
      eur: Math.max(prev?.eur ?? 0, r.weight_eur),
    });
  }
  const ranked = [...strongest.entries()]
    .sort(([aId, a], [bId, b]) => b.times - a.times || b.eur - a.eur || aId.localeCompare(bId))
    .map(([id]) => id);
  const drawn = new Set(ranked.slice(0, maxTies));

  // Nodes are emitted in tie-strength order, not in row order: the ring is laid out by node index, so
  // the layout would otherwise depend on how the rows happened to arrive.
  const firstRowOf = new Map<string, LinkRow>();
  for (const r of tieRes.results) if (!firstRowOf.has(r.other_id)) firstRowOf.set(r.other_id, r);
  const nodes: CompanyTieNode[] = [center];
  const seen = new Set([center.id]);
  for (const id of ranked) {
    if (!drawn.has(id)) continue;
    const r = firstRowOf.get(id)!;
    seen.add(id);
    nodes.push(companyNode(id, r.other_name, r.other_kind, r.other_won_eur, r.other_conflicts, 1));
  }

  const edges: CompanyTieEdge[] = [];
  for (const r of tieRes.results) {
    if (!drawn.has(r.other_id)) continue;
    // Direction is a property of the stored row, not of which side the centre is on: a subcontract row is
    // always prime → sub, so the arrow must survive the centre sitting at either end.
    edges.push({
      from: r.a_bidder_id,
      to: r.b_bidder_id,
      kind: r.kind,
      directed: r.directed === 1,
      weightEur: r.weight_eur,
      occurrences: r.occurrences,
      href: r.kind === 'declared_stake' ? `/conflicts/company/${companySlug(bidderId)}` : null,
    });
  }

  if (opts.includeFunders) {
    const funders = await db.prepare(FUNDERS_SQL).bind(bidderId, MAX_FUNDERS).all<FunderRow>();
    for (const f of funders.results) {
      if (seen.has(f.authority_id)) continue;
      seen.add(f.authority_id);
      nodes.push({
        id: f.authority_id,
        kind: 'authority',
        label: cleanName(f.authority_name),
        slug: authoritySlug(f.authority_id),
        valueEur: f.won_eur,
        hop: 1,
        conflictsHref: null,
      });
      edges.push({
        from: f.authority_id,
        to: bidderId,
        kind: 'money',
        directed: true,
        weightEur: f.won_eur,
        occurrences: 0,
        href: null,
      });
    }
  }

  return { center, nodes, edges, omitted: Math.max(0, ranked.length - drawn.size) };
}

/** Suppliers drawn around an authority. Enough to show a cluster without becoming a hairball. */
const MAX_SUPPLIERS = 9;

interface SupplierRow {
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  won_eur: number;
  conflicts: number;
}

const SUPPLIERS_SQL = `
  SELECT fp.bidder_id, fp.bidder_name, fp.bidder_kind, fp.won_eur,
         ${surfacedConflicts('fp.bidder_id')} AS conflicts
  FROM flow_pairs fp WHERE fp.authority_id = ?1
  ORDER BY fp.won_eur DESC LIMIT ?2`;

const AUTHORITY_SQL = `SELECT name, spent_eur FROM authority_totals WHERE authority_id = ?1`;

/**
 * „The biggest suppliers of this institution, and which of them are tied to each other" — the authority
 * half of the same question. The ring is the authority's top suppliers by spend; the edges
 * are the money that put them there PLUS every tie that exists between two of them.
 *
 * The interesting edge is the second kind: two of one body's largest suppliers who bid together, or
 * subcontract to each other, or share a declared interest. That is invisible on a leaderboard.
 */
export async function getAuthoritySupplierTies(
  db: D1Database,
  authorityId: string,
  opts: { maxSuppliers?: number } = {},
): Promise<CompanyTieNetwork> {
  const limit = opts.maxSuppliers ?? MAX_SUPPLIERS;
  const [auth, suppliers] = await Promise.all([
    db.prepare(AUTHORITY_SQL).bind(authorityId).first<{ name: string; spent_eur: number }>(),
    db.prepare(SUPPLIERS_SQL).bind(authorityId, limit).all<SupplierRow>(),
  ]);
  if (!auth || suppliers.results.length === 0) {
    return { center: null, nodes: [], edges: [], omitted: 0 };
  }

  const center: CompanyTieNode = {
    id: authorityId,
    kind: 'authority',
    label: cleanName(auth.name),
    slug: authoritySlug(authorityId),
    valueEur: auth.spent_eur,
    hop: 0,
    conflictsHref: null,
  };
  const nodes: CompanyTieNode[] = [center];
  const edges: CompanyTieEdge[] = [];
  const ids: string[] = [];
  for (const s of suppliers.results) {
    ids.push(s.bidder_id);
    nodes.push(companyNode(s.bidder_id, s.bidder_name, s.bidder_kind, s.won_eur, s.conflicts, 1));
    edges.push({
      from: authorityId,
      to: s.bidder_id,
      kind: 'money',
      directed: true,
      weightEur: s.won_eur,
      occurrences: 0,
      href: null,
    });
  }

  // Ties BETWEEN the drawn suppliers. Bound by the ring size, so the IN-list is small and fixed.
  const marks = ids.map(() => '?').join(',');
  const between = await db
    .prepare(
      `SELECT a_bidder_id, b_bidder_id, kind, directed, weight_eur, occurrences
         FROM company_links
        WHERE a_bidder_id IN (${marks}) AND b_bidder_id IN (${marks})
        ORDER BY occurrences DESC, weight_eur DESC`,
    )
    .bind(...ids, ...ids)
    .all<{
      a_bidder_id: string;
      b_bidder_id: string;
      kind: 'consortium' | 'subcontract' | 'declared_stake';
      directed: number;
      weight_eur: number;
      occurrences: number;
    }>();
  for (const r of between.results) {
    edges.push({
      from: r.a_bidder_id,
      to: r.b_bidder_id,
      kind: r.kind,
      directed: r.directed === 1,
      weightEur: r.weight_eur,
      occurrences: r.occurrences,
      href: r.kind === 'declared_stake' ? `/conflicts/company/${companySlug(r.a_bidder_id)}` : null,
    });
  }

  return { center, nodes, edges, omitted: 0 };
}
