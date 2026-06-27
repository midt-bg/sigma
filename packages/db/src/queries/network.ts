// Relationship graph — the ego network around one entity (authority or company) for the /network page.
// Centre + its top direct counterparties (hop 1) + each counterparty's single top other counterparty
// (hop 2), which surfaces clusters (suppliers shared across authorities, authorities sharing suppliers)
// that the global /flows Sankey does not. Reads the flow_pairs rollup (cheap); no new precompute table.

import type {
  NetworkCenterOption,
  NetworkData,
  NetworkEdge,
  NetworkNode,
} from '@sigma/api-contract';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';

export type NetworkCenterKind = 'authority' | 'company';
export interface NetworkParams {
  kind: NetworkCenterKind;
  id: string;
}

export interface NetworkQueryOptions {
  includeCenterOptions?: boolean;
}

const HOP1 = 6; // direct counterparties shown
const HOP2_SCAN = HOP1 * 10; // rows scanned for hop 2 before the top-1-per-neighbour reduction
const PICKER_LIMIT = 12; // entities offered in the centre picker

interface PairRow {
  authority_id: string;
  bidder_id: string;
  authority_name: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  won_eur: number;
  contracts: number;
}

type Center = NonNullable<NetworkData['center']>;

function authorityNodeOf(r: PairRow, hop: number): NetworkNode {
  return {
    id: r.authority_id,
    kind: 'authority',
    label: cleanName(r.authority_name),
    slug: authoritySlug(r.authority_id),
    valueEur: 0, // node size is the incident-edge sum, set in getEntityNetwork below
    hop,
  };
}

function companyNodeOf(r: PairRow, hop: number): NetworkNode {
  const name = cleanName(r.bidder_name);
  return {
    id: r.bidder_id,
    kind: 'company',
    label: entityName(name, r.bidder_kind),
    slug: companySlug(r.bidder_id),
    valueEur: 0, // node size is the incident-edge sum, set in getEntityNetwork below
    hop,
  };
}

async function loadCenterOptions(
  db: D1Database,
): Promise<{ authorities: NetworkCenterOption[]; companies: NetworkCenterOption[] }> {
  const [a, c] = await Promise.all([
    db
      .prepare(
        `SELECT authority_id, name FROM authority_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.authority_id = authority_totals.authority_id)
         ORDER BY spent_eur DESC, authority_id LIMIT ?`,
      )
      .bind(PICKER_LIMIT)
      .all<{ authority_id: string; name: string }>(),
    db
      .prepare(
        `SELECT bidder_id, name, kind FROM company_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.bidder_id = company_totals.bidder_id)
         ORDER BY won_eur DESC, bidder_id LIMIT ?`,
      )
      .bind(PICKER_LIMIT)
      .all<{ bidder_id: string; name: string; kind: 'company' | 'consortium' }>(),
  ]);
  return {
    authorities: a.results.map((r) => ({
      kind: 'authority',
      label: cleanName(r.name),
      value: `a:${authoritySlug(r.authority_id)}`,
    })),
    companies: c.results.map((r) => ({
      kind: 'company',
      label: entityName(cleanName(r.name), r.kind),
      value: `c:${companySlug(r.bidder_id)}`,
    })),
  };
}

function emptyCenterOptions(): {
  authorities: NetworkCenterOption[];
  companies: NetworkCenterOption[];
} {
  return { authorities: [], companies: [] };
}

async function loadCenter(
  db: D1Database,
  p: NetworkParams,
  sample?: PairRow,
): Promise<Center | null> {
  if (p.kind === 'authority') {
    const row = await db
      .prepare(`SELECT name, spent_eur FROM authority_totals WHERE authority_id = ?`)
      .bind(p.id)
      .first<{ name: string; spent_eur: number }>();
    const name = row?.name ?? sample?.authority_name;
    if (name == null) return null;
    return {
      id: p.id,
      kind: 'authority',
      label: cleanName(name),
      slug: authoritySlug(p.id),
      valueEur: row?.spent_eur ?? 0,
    };
  }
  const row = await db
    .prepare(`SELECT name, kind, won_eur FROM company_totals WHERE bidder_id = ?`)
    .bind(p.id)
    .first<{ name: string; kind: 'company' | 'consortium'; won_eur: number }>();
  const name = row?.name ?? sample?.bidder_name;
  if (name == null) return null;
  return {
    id: p.id,
    kind: 'company',
    label: entityName(cleanName(name), row?.kind ?? sample?.bidder_kind ?? 'company'),
    slug: companySlug(p.id),
    valueEur: row?.won_eur ?? 0,
  };
}

export async function getEntityNetwork(
  db: D1Database,
  p: NetworkParams | null,
  options: NetworkQueryOptions = {},
): Promise<NetworkData> {
  const includeCenterOptions = options.includeCenterOptions ?? true;
  if (!p) {
    // Default centre: the biggest authority by spend, so the page shows something on first load.
    const top = await db
      .prepare(
        `SELECT authority_id FROM authority_totals
         WHERE EXISTS (SELECT 1 FROM flow_pairs f WHERE f.authority_id = authority_totals.authority_id)
         ORDER BY spent_eur DESC, authority_id LIMIT 1`,
      )
      .first<{ authority_id: string }>();
    if (!top) {
      return {
        center: null,
        nodes: [],
        edges: [],
        centerOptions: includeCenterOptions ? await loadCenterOptions(db) : emptyCenterOptions(),
      };
    }
    p = { kind: 'authority', id: top.authority_id };
  }
  const isAuth = p.kind === 'authority';
  const centerCol = isAuth ? 'authority_id' : 'bidder_id';
  const neighborCol = isAuth ? 'bidder_id' : 'authority_id';

  const [centerOptions, hop1res] = await Promise.all([
    includeCenterOptions ? loadCenterOptions(db) : Promise.resolve(emptyCenterOptions()),
    db
      .prepare(
        `SELECT authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts
         FROM flow_pairs WHERE ${centerCol} = ? ORDER BY won_eur DESC LIMIT ?`,
      )
      .bind(p.id, HOP1)
      .all<PairRow>(),
  ]);
  const hop1 = hop1res.results;

  const center = await loadCenter(db, p, hop1[0]);
  if (!center) return { center: null, nodes: [], edges: [], centerOptions };

  const nodes = new Map<string, NetworkNode>([[center.id, { ...center, hop: 0 }]]);
  const edges: NetworkEdge[] = [];
  const neighborIds: string[] = [];
  for (const r of hop1) {
    const node = isAuth ? companyNodeOf(r, 1) : authorityNodeOf(r, 1);
    if (node.id === center.id) continue;
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    edges.push({ from: center.id, to: node.id, valueEur: r.won_eur, contracts: r.contracts });
    neighborIds.push(node.id);
  }

  // hop 2: each direct neighbour's single top OTHER counterparty (same kind as the centre). LIMIT caps
  // the scan so a high-degree neighbour cannot pull hundreds of rows; the top-1-per-neighbour reduction
  // then runs in JS over that bounded set.
  if (neighborIds.length) {
    const placeholders = neighborIds.map(() => '?').join(', ');
    const hop2 = (
      await db
        .prepare(
          `SELECT authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts
           FROM flow_pairs WHERE ${neighborCol} IN (${placeholders}) AND ${centerCol} != ?
           ORDER BY won_eur DESC LIMIT ?`,
        )
        .bind(...neighborIds, p.id, HOP2_SCAN)
        .all<PairRow>()
    ).results;
    const seenNeighbor = new Set<string>();
    for (const r of hop2) {
      const neighborId = isAuth ? r.bidder_id : r.authority_id;
      if (seenNeighbor.has(neighborId)) continue; // top-1 per neighbour
      seenNeighbor.add(neighborId);
      const node = isAuth ? authorityNodeOf(r, 2) : companyNodeOf(r, 2);
      if (node.id === center.id) continue;
      // hop 1 and hop 2 are always opposite kinds, so a hop-2 row never lands on a hop-1 node. When two
      // neighbours share the same hop-2 counterparty the node is kept once and both edges are added on
      // purpose: that shared link is exactly the cluster the graph is meant to surface.
      if (!nodes.has(node.id)) nodes.set(node.id, { ...node, hop: 2 });
      edges.push({ from: neighborId, to: node.id, valueEur: r.won_eur, contracts: r.contracts });
    }
  }

  // Node weight = sum of incident edge values (drives the circle size in the graph).
  const weight = new Map<string, number>();
  for (const e of edges) {
    weight.set(e.from, (weight.get(e.from) ?? 0) + e.valueEur);
    weight.set(e.to, (weight.get(e.to) ?? 0) + e.valueEur);
  }
  const nodeList = [...nodes.values()].map((nd) => ({
    ...nd,
    valueEur: weight.get(nd.id) ?? nd.valueEur,
  }));

  return { center, nodes: nodeList, edges, centerOptions };
}
