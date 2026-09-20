// The tie network around one company — who a company is connected to, and how.
//
// The profile graph used to draw `flow_pairs` only: authority ⇄ winner, i.e. money and nothing else, with
// no company↔company edge in it at all. The question a reader brings to a company profile is „who is this
// company tied to", and four kinds of answer are in the corpus:
//
//   consortium     joint bidding — both are named members of the same обединение that won
//   subcontract    one was recorded as the other's subcontractor
//   declared_stake the same office-holder declared an interest in both
//   role           a person, or a company, the Trade Register records in a role at the company (ADR-0039)
//
// plus the money layer (`flow_pairs`) kept as context: which institutions the money comes from.
//
// The company ties come precomputed from `company_links` (see migration 0011 + precompute.sql §5b). The role
// ties come from the registry layer (`registry_roles`, ADR-0041) by indexed reads: the centre's partida, then
// the other partidas its people hold a role in.
//
// A declared-stake office-holder is never a node: that tie is drawn between the two COMPANIES and links to
// /conflicts, where the name is published under its own rules. The people drawn as nodes are the ones the
// Trade Register records in a role, named as it names them.
import type {
  CompanyTieEdge,
  CompanyTieNetwork,
  CompanyTieNode,
  RegistryRoleKind,
} from '@sigma/api-contract';
import { cleanName, registryCompanyName } from '@sigma/shared';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';
import { authoritySlug, companySlug, personSlug } from './identity';
import {
  joinablePerson,
  partidaEik,
  publicRole,
  registryRead,
  roleEdge,
  roleRank,
} from './registry';
import { companyNode, personNode, personNodeId } from './tie-node';

/** Tied companies drawn around the centre. Beyond this the ring stops being readable. */
const MAX_TIES = 8;
/** Paying institutions drawn as the money layer, when asked for. */
const MAX_FUNDERS = 3;
/** People drawn at the centre, the other companies they reach, and the centre's owners and holdings. */
const MAX_PERSONS = 6;
const MAX_VIA_PERSONS = 6;
const MAX_HOLDINGS = 4;
/** People of the centre whose other roles are looked up: a bound on the IN-list, well inside D1's binds. */
const MAX_LOOKUP = 40;

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

const REGISTRY_CENTER_SQL = `
  SELECT 'eik:' || eik AS id, COALESCE(name, eik) AS name, legal_form, 'company' AS kind,
         NULL AS won_eur, 0 AS conflicts
  FROM registry_deeds WHERE eik = ?1 AND outcome = 'ok'`;

const CENTER_SQL = `
  SELECT b.id, b.name, b.kind, ct.won_eur,
         ${surfacedConflicts('b.id')} AS conflicts
  FROM bidders b LEFT JOIN company_totals ct ON ct.bidder_id = b.id
  WHERE b.id = ?1`;

// ---- the registry layer -------------------------------------------------------------------------------------

interface HolderRow {
  indent: string;
  name: string;
  role: RegistryRoleKind;
  removed_on: string | null;
}

interface SharedRow extends HolderRow {
  eik: string;
}

interface ViaRow {
  indent: string;
  role: RegistryRoleKind;
  removed_on: string | null;
  bidder_id: string;
  name: string;
  kind: 'company' | 'consortium';
  won_eur: number | null;
  conflicts: number;
}

interface HoldingRow {
  side: 'owner' | 'owned';
  role: RegistryRoleKind;
  removed_on: string | null;
  bidder_id: string;
  name: string;
  kind: 'company' | 'consortium';
  won_eur: number | null;
  conflicts: number;
}

// The people the register records at the centre, by the name it last registered for them.
const CENTRE_PEOPLE_SQL = `
  SELECT r.subject_id AS indent, COALESCE(p.name, r.subject_name) AS name, r.role, r.removed_on
  FROM registry_roles r LEFT JOIN registry_persons p ON p.indent = r.subject_id
  WHERE r.eik = ?1 AND ${joinablePerson('r')} AND ${publicRole('r')}`;

// The other PRIVATE companies in the corpus those people hold a role in. A seat at a public enterprise is a
// held position, not a company of the person (ADR-0047 §2): drawing it here would hang the enterprise's
// contracts on whoever sits on its board.
const viaPeopleSql = (n: number) => `
  SELECT r.subject_id AS indent, r.role, r.removed_on, b.id AS bidder_id, b.name, b.kind, ct.won_eur,
         ${surfacedConflicts('b.id')} AS conflicts
  FROM registry_roles r
  JOIN bidders b ON b.id = 'eik:' || r.eik AND b.ownership_kind IS NULL
  LEFT JOIN company_totals ct ON ct.bidder_id = b.id
  WHERE r.subject_id IN (${Array.from({ length: n }, (_, i) => `?${i + 2}`).join(', ')})
    AND r.subject_kind = 'person' AND r.eik <> ?1 AND ${publicRole('r')}`;

// Companies in the corpus that hold a role at the centre — its owners, mostly — and those it holds one at.
const HOLDINGS_SQL = `
  SELECT 'owner' AS side, r.role, r.removed_on, b.id AS bidder_id, b.name, b.kind, ct.won_eur,
         ${surfacedConflicts('b.id')} AS conflicts
  FROM registry_roles r
  JOIN bidders b ON b.id = 'eik:' || r.subject_id
  LEFT JOIN company_totals ct ON ct.bidder_id = b.id
  WHERE r.eik = ?1 AND r.subject_kind = 'entity' AND r.subject_id <> ?1 AND ${publicRole('r')}
  UNION ALL
  SELECT 'owned' AS side, r.role, r.removed_on, b.id AS bidder_id, b.name, b.kind, ct.won_eur,
         ${surfacedConflicts('b.id')} AS conflicts
  FROM registry_roles r
  JOIN bidders b ON b.id = 'eik:' || r.eik
  LEFT JOIN company_totals ct ON ct.bidder_id = b.id
  WHERE r.subject_kind = 'entity' AND r.subject_id = ?1 AND r.eik <> ?1 AND ${publicRole('r')}`;

/** What a layer adds to a network. */
interface Layer {
  nodes: CompanyTieNode[];
  edges: CompanyTieEdge[];
  omitted: number;
}

/** The roles one holder holds at one company, each once, and whether any still stands. */
interface Held {
  roles: RegistryRoleKind[];
  current: boolean;
}

function hold(
  into: Map<string, Held>,
  key: string,
  role: RegistryRoleKind,
  removedOn: string | null,
): void {
  const h = into.get(key) ?? { roles: [], current: false };
  if (!h.roles.includes(role)) h.roles.push(role);
  h.current ||= removedOn === null;
  into.set(key, h);
}

const seniority = (h: Held) => Math.min(...h.roles.map(roleRank));

/** The registry layer around a company: its people, the companies they reach, its owners and holdings. */
async function companyRegistryLayer(
  db: D1Database,
  centreId: string,
  eik: string,
  drawnIds: ReadonlySet<string>,
): Promise<Layer> {
  const [people, holdings] = await Promise.all([
    db.prepare(CENTRE_PEOPLE_SQL).bind(eik).all<HolderRow>(),
    db.prepare(HOLDINGS_SQL).bind(eik).all<HoldingRow>(),
  ]);
  const names = new Map<string, string>();
  const atCentre = new Map<string, Held>();
  for (const r of people.results) {
    names.set(r.indent, r.name);
    hold(atCentre, r.indent, r.role, r.removed_on);
  }
  // Standing people first, the more senior first: the lookup is bounded, and these are the ones to keep.
  const standing = [...atCentre.keys()].sort((a, b) => {
    const [x, y] = [atCentre.get(a)!, atCentre.get(b)!];
    return (
      Number(y.current) - Number(x.current) ||
      seniority(x) - seniority(y) ||
      names.get(a)!.localeCompare(names.get(b)!, 'bg')
    );
  });
  const asked = standing.slice(0, MAX_LOOKUP);
  const via = asked.length
    ? (
        await db
          .prepare(viaPeopleSql(asked.length))
          .bind(eik, ...asked)
          .all<ViaRow>()
      ).results
    : [];

  // A person who also holds a role at another company is what the graph is for: drawn first.
  const reach = new Map<string, Set<string>>();
  for (const v of via)
    reach.set(v.indent, (reach.get(v.indent) ?? new Set<string>()).add(v.bidder_id));
  const ranked = [...standing].sort(
    (a, b) => (reach.get(b)?.size ?? 0) - (reach.get(a)?.size ?? 0),
  );
  const drawnPeople = ranked.slice(0, MAX_PERSONS);
  const layer: Layer = { nodes: [], edges: [], omitted: ranked.length - drawnPeople.length };
  for (const i of drawnPeople) {
    const h = atCentre.get(i)!;
    layer.nodes.push(personNode(i, names.get(i)!, 1));
    layer.edges.push(roleEdge(personNodeId(i), centreId, h.roles, h.current, false));
  }

  // The other companies the drawn people hold a role in, the ones most of them share first.
  const drawnSet = new Set(drawnPeople);
  const reached = new Map<string, { row: ViaRow; held: Map<string, Held> }>();
  for (const v of via) {
    if (!drawnSet.has(v.indent)) continue;
    const c = reached.get(v.bidder_id) ?? { row: v, held: new Map<string, Held>() };
    hold(c.held, v.indent, v.role, v.removed_on);
    reached.set(v.bidder_id, c);
  }
  const shown = new Set(drawnIds);
  let added = 0;
  const byShared = [...reached.values()].sort(
    (a, b) =>
      b.held.size - a.held.size ||
      (b.row.won_eur ?? 0) - (a.row.won_eur ?? 0) ||
      a.row.bidder_id.localeCompare(b.row.bidder_id),
  );
  for (const c of byShared) {
    const id = c.row.bidder_id;
    if (!shown.has(id)) {
      if (added === MAX_VIA_PERSONS) {
        layer.omitted++;
        continue;
      }
      added++;
      shown.add(id);
      layer.nodes.push(companyNode(id, c.row.name, c.row.kind, c.row.won_eur, c.row.conflicts, 2));
    }
    for (const [i, h] of c.held)
      layer.edges.push(roleEdge(personNodeId(i), id, h.roles, h.current, false));
  }

  // The companies that hold a role at the centre, and those it holds one at — standing ones first.
  const rows = new Map<string, HoldingRow>();
  const held = new Map<string, Held>();
  for (const o of holdings.results) {
    const key = `${o.side}|${o.bidder_id}`;
    if (!rows.has(key)) rows.set(key, o);
    hold(held, key, o.role, o.removed_on);
  }
  const byStanding = [...rows.keys()].sort(
    (a, b) =>
      Number(held.get(b)!.current) - Number(held.get(a)!.current) ||
      (rows.get(b)!.won_eur ?? 0) - (rows.get(a)!.won_eur ?? 0) ||
      a.localeCompare(b),
  );
  let holdingsAdded = 0;
  for (const key of byStanding) {
    const [o, h] = [rows.get(key)!, held.get(key)!];
    if (!shown.has(o.bidder_id)) {
      if (holdingsAdded === MAX_HOLDINGS) {
        layer.omitted++;
        continue;
      }
      holdingsAdded++;
      shown.add(o.bidder_id);
      layer.nodes.push(companyNode(o.bidder_id, o.name, o.kind, o.won_eur, o.conflicts, 1));
    }
    layer.edges.push(
      o.side === 'owner'
        ? roleEdge(o.bidder_id, centreId, h.roles, h.current, true)
        : roleEdge(centreId, o.bidder_id, h.roles, h.current, true),
    );
  }
  return layer;
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
  // A company known only from its partida is still the centre of its people.
  const partida = partidaEik(bidderId);
  const centerRow =
    centerRes ??
    (partida
      ? await registryRead(
          () =>
            db
              .prepare(REGISTRY_CENTER_SQL)
              .bind(partida)
              .first<CenterRow & { legal_form: string | null }>()
              .then((r) => r && { ...r, name: registryCompanyName(r.name, r.legal_form) }),
          null,
        )
      : null);
  if (!centerRow) return { center: null, nodes: [], edges: [], omitted: 0 };

  const center = companyNode(
    centerRow.id,
    centerRow.name,
    centerRow.kind,
    centerRow.won_eur,
    centerRow.conflicts,
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
      href:
        r.kind === 'declared_stake' ? `/companies/${companySlug(bidderId)}#declared-people` : null,
    });
  }
  let omitted = Math.max(0, ranked.length - drawn.size);

  // The Trade Register layer: the centre's people, the companies they reach, its owners and holdings.
  if (partida) {
    const layer = await registryRead(() => companyRegistryLayer(db, bidderId, partida, seen), null);
    if (layer) {
      for (const n of layer.nodes) seen.add(n.id);
      nodes.push(...layer.nodes);
      edges.push(...layer.edges);
      omitted += layer.omitted;
    }
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

  await attachDeclaredPeople(db, edges);
  return { center, nodes, edges, omitted };
}

/** Suppliers drawn around an authority. Enough to show a cluster without becoming a hairball. */
const MAX_SUPPLIERS = 9;
/** People drawn between the suppliers. */
const MAX_SHARED_PERSONS = 6;

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

/** The registry layer between suppliers: people at two or more of them, and suppliers holding roles at others. */
async function supplierRegistryLayer(
  db: D1Database,
  partidas: ReadonlyMap<string, string>,
): Promise<Layer> {
  const eiks = [...partidas.keys()];
  const marks = eiks.map(() => '?').join(', ');
  const [people, holdings] = await Promise.all([
    db
      .prepare(
        `SELECT r.subject_id AS indent, COALESCE(p.name, r.subject_name) AS name, r.eik, r.role, r.removed_on
           FROM registry_roles r LEFT JOIN registry_persons p ON p.indent = r.subject_id
          WHERE r.eik IN (${marks}) AND ${joinablePerson('r')} AND ${publicRole('r')}`,
      )
      .bind(...eiks)
      .all<SharedRow>(),
    db
      .prepare(
        `SELECT r.eik, r.subject_id, r.role, r.removed_on
           FROM registry_roles r
          WHERE r.eik IN (${marks}) AND r.subject_kind = 'entity' AND r.subject_id IN (${marks})
            AND r.subject_id <> r.eik AND ${publicRole('r')}`,
      )
      .bind(...eiks, ...eiks)
      .all<{
        eik: string;
        subject_id: string;
        role: RegistryRoleKind;
        removed_on: string | null;
      }>(),
  ]);

  const names = new Map<string, string>();
  const byPerson = new Map<string, Map<string, Held>>();
  for (const r of people.results) {
    names.set(r.indent, r.name);
    const at = byPerson.get(r.indent) ?? new Map<string, Held>();
    hold(at, r.eik, r.role, r.removed_on);
    byPerson.set(r.indent, at);
  }
  const standing = (i: string) => [...byPerson.get(i)!.values()].some((h) => h.current);
  const shared = [...byPerson.keys()]
    .filter((i) => byPerson.get(i)!.size >= 2)
    .sort(
      (a, b) =>
        byPerson.get(b)!.size - byPerson.get(a)!.size ||
        Number(standing(b)) - Number(standing(a)) ||
        names.get(a)!.localeCompare(names.get(b)!, 'bg'),
    );
  const drawn = shared.slice(0, MAX_SHARED_PERSONS);
  const layer: Layer = { nodes: [], edges: [], omitted: shared.length - drawn.length };
  for (const i of drawn) {
    layer.nodes.push(personNode(i, names.get(i)!, 2));
    for (const [eik, h] of byPerson.get(i)!)
      layer.edges.push(roleEdge(personNodeId(i), partidas.get(eik)!, h.roles, h.current, false));
  }

  const cross = new Map<string, Held>();
  for (const r of holdings.results) hold(cross, `${r.subject_id}|${r.eik}`, r.role, r.removed_on);
  for (const [key, h] of cross) {
    const [holder, eik] = key.split('|') as [string, string];
    layer.edges.push(roleEdge(partidas.get(holder)!, partidas.get(eik)!, h.roles, h.current, true));
  }
  return layer;
}

/**
 * „The biggest suppliers of this institution, and which of them are tied to each other" — the authority
 * half of the same question. The ring is the authority's top suppliers by spend; the edges
 * are the money that put them there PLUS every tie that exists between two of them.
 *
 * The interesting edge is the second kind: two of one body's largest suppliers who bid together, or
 * subcontract to each other, share a declared interest, or share a manager or an owner. That is invisible
 * on a leaderboard.
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
      href:
        r.kind === 'declared_stake'
          ? `/companies/${companySlug(r.a_bidder_id)}#declared-people`
          : null,
    });
  }

  // The Trade Register layer: people who hold a role at two or more of the drawn suppliers, and suppliers
  // that hold a role at one another.
  const partidas = new Map<string, string>();
  for (const id of ids) {
    const eik = partidaEik(id);
    if (eik) partidas.set(eik, id);
  }
  let omitted = 0;
  if (partidas.size >= 2) {
    const layer = await registryRead(() => supplierRegistryLayer(db, partidas), null);
    if (layer) {
      nodes.push(...layer.nodes);
      edges.push(...layer.edges);
      omitted = layer.omitted;
    }
  }

  await attachDeclaredPeople(db, edges);
  return { center, nodes, edges, omitted };
}

/** Re-read the named basis through the publication gate; a precomputed count alone is not evidence. */
async function attachDeclaredPeople(db: D1Database, edges: CompanyTieEdge[]) {
  await Promise.all(
    edges
      .filter((e) => e.kind === 'declared_stake')
      .map(async (edge) => {
        const rows = await db
          .prepare(
            `WITH surfaced AS (
      SELECT DISTINCT il.person_id, il.bidder_id FROM interest_links il
      WHERE ${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}
    ) SELECT DISTINCT p.id, p.name FROM surfaced x JOIN surfaced y ON y.person_id=x.person_id
      JOIN persons p ON p.id=x.person_id WHERE x.bidder_id=? AND y.bidder_id=? ORDER BY p.name`,
          )
          .bind(edge.from, edge.to)
          .all<{ id: string; name: string }>();
        edge.people = rows.results.map((p) => ({
          ...p,
          href: `/persons/${personSlug(p.id)}`,
        }));
        edge.occurrences = edge.people.length;
      }),
  );
}
