// Flows — money from authorities (left) to companies (right). The default (all sectors, 2020–2026,
// all funding) reads the flow_pairs rollup top-N; a sector/year/funding filter falls back to a scoped
// base aggregation. The Sankey geometry (node bars + bezier ribbons) is computed HERE, in the loader,
// and emitted as a static SVG — the mock ships no chart JS. Always paired with the top-N table.

import type {
  FlowPair,
  FlowsData,
  SankeyLayout,
  SankeyNode,
  SankeyRibbon,
} from '@sigma/api-contract';
import {
  cleanName,
  entityName,
  isNaturalPersonBidder,
  MASKED_NATURAL_PERSON_LABEL,
  money,
} from '@sigma/shared';
import { authoritySlug, companySlug, maskedCompanySlug } from './identity';
import { sectorOptions } from './sectors';

export interface FlowsParams {
  sector?: string | null;
  year?: string | null;
  funding?: 'all' | 'eu' | 'national';
  top?: number;
}

interface PairRow {
  authority_id: string;
  bidder_id: string;
  authority_name: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  bidder_legal_form: string | null;
  won_eur: number;
  contracts: number;
}

async function topPairs(db: D1Database, p: FlowsParams, top: number): Promise<PairRow[]> {
  const filtered = Boolean(p.sector || p.year || (p.funding && p.funding !== 'all'));
  if (!filtered) {
    // The `flow_pairs` rollup is a denormalized projection — it does not store `bidder_legal_form`.
    // JOIN against `bidders` to recover the natural-person signal so the loader can mask sole-trader
    // pairs the same way `toCompanyListItem` does on /companies + /companies.data (PR #183 #115163a).
    // The PK index on `bidders(id)` keeps the JOIN cheap; the (authority_id, bidder_id) PK on the
    // rollup still drives the won-order scan. lyubomir-bozhinov review 2026-09-02, thread on
    // packages/db/src/queries/rows.ts:86 (extended from the company mapper to the flows mapper).
    const { results } = await db
      .prepare(
        `SELECT fp.authority_id, fp.bidder_id, fp.authority_name, fp.bidder_name,
                fp.bidder_kind, b.legal_form AS bidder_legal_form,
                fp.won_eur, fp.contracts
         FROM flow_pairs fp JOIN bidders b ON b.id = fp.bidder_id
         ORDER BY fp.won_eur DESC LIMIT ?`,
      )
      .bind(top)
      .all<PairRow>();
    return results;
  }
  const where = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.year) {
    where.push('substr(c.signed_at, 1, 4) = ?');
    params.push(p.year);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  const { results } = await db
    .prepare(
      `SELECT t.authority_id, c.bidder_id, a.name AS authority_name,
              b.name AS bidder_name, b.kind AS bidder_kind, b.legal_form AS bidder_legal_form,
              SUM(c.amount_eur) AS won_eur, COUNT(*) AS contracts
       FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE ${where.join(' AND ')}
       GROUP BY t.authority_id, c.bidder_id ORDER BY won_eur DESC LIMIT ?`,
    )
    .bind(...params, top)
    .all<PairRow>();
  return results;
}

// ── Sankey layout ───────────────────────────────────────────────────────────────────────────────
const Y_TOP = 20;
const Y_BOTTOM = 600;
const GAP = 6;
const A_X = 140; // authority bar left
const C_X = 540; // company bar left
const BAR_W = 20;
const MID_X = 350; // bezier control x

function truncate(s: string, n = 30): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildSankey(pairs: PairRow[]): SankeyLayout {
  // Column node totals (each pair contributes to one authority + one company; both columns sum equal).
  // Privacy (PR #183 review): aggregate the bidder label across ALL its incoming flows before deciding
  // whether to mask — a sole trader that recurs across authorities must read „Частно лице" on the
  // Sankey bar, not its real name. The same `bidder_kind !== 'consortium' && isNaturalPersonBidder`
  // guard used in `toCompanyListItem` + `toItem` (contract mapper) applies here. The masked bidder
  // also drops the `/companies/<bare ЕИК>` `href` on the right-column node (the masked profile is
  // reachable only via direct URL or a noindexed contract-page backlink).
  // lyubomir-bozhinov review 2026-09-02, thread on packages/db/src/queries/rows.ts:86 (extended to
  // the flows mapper).
  const authAgg = new Map<string, { name: string; value: number }>();
  const compAgg = new Map<
    string,
    {
      name: string;
      kind: 'company' | 'consortium';
      legalForm: string | null;
      masked: boolean;
      value: number;
    }
  >();
  for (const p of pairs) {
    const authorityName = cleanName(p.authority_name);
    const bidderName = cleanName(p.bidder_name);
    const a = authAgg.get(p.authority_id) ?? { name: authorityName, value: 0 };
    a.value += p.won_eur;
    authAgg.set(p.authority_id, a);
    const c = compAgg.get(p.bidder_id);
    if (!c) {
      const masked =
        p.bidder_kind !== 'consortium' && isNaturalPersonBidder(bidderName, p.bidder_legal_form);
      compAgg.set(p.bidder_id, {
        name: masked ? MASKED_NATURAL_PERSON_LABEL : bidderName,
        kind: p.bidder_kind,
        legalForm: p.bidder_legal_form,
        masked,
        value: p.won_eur,
      });
    } else {
      c.value += p.won_eur;
    }
  }
  const authIds = [...authAgg.keys()].sort((x, y) => authAgg.get(y)!.value - authAgg.get(x)!.value);
  const compIds = [...compAgg.keys()].sort((x, y) => compAgg.get(y)!.value - compAgg.get(x)!.value);
  const total = pairs.reduce((s, p) => s + p.won_eur, 0) || 1;

  const scaleA = (Y_BOTTOM - Y_TOP - (authIds.length - 1) * GAP) / total;
  const scaleC = (Y_BOTTOM - Y_TOP - (compIds.length - 1) * GAP) / total;

  // Place node bars + seed the outflow/inflow offsets used to stack ribbon bands.
  const aPos = new Map<string, { y: number; h: number; off: number; index: number }>();
  const cPos = new Map<string, { y: number; h: number; off: number; index: number }>();
  const nodes: SankeyNode[] = [];
  let ay = Y_TOP;
  authIds.forEach((id, i) => {
    const h = Math.max(1, authAgg.get(id)!.value * scaleA);
    aPos.set(id, { y: ay, h, off: ay, index: i });
    nodes.push({
      label: truncate(authAgg.get(id)!.name),
      valueEur: authAgg.get(id)!.value,
      side: 'authority',
      x: A_X,
      y: ay,
      width: BAR_W,
      height: h,
      labelY: ay + h / 2,
      href: `/authorities/${authoritySlug(id)}`,
    });
    ay += h + GAP;
  });
  let cy = Y_TOP;
  compIds.forEach((id, i) => {
    const agg = compAgg.get(id)!;
    const h = Math.max(1, agg.value * scaleC);
    cPos.set(id, { y: cy, h, off: cy, index: i });
    nodes.push({
      label: truncate(agg.masked ? MASKED_NATURAL_PERSON_LABEL : entityName(agg.name, agg.kind)),
      valueEur: agg.value,
      side: 'company',
      x: C_X,
      y: cy,
      width: BAR_W,
      height: h,
      labelY: cy + h / 2,
      // Masked bidders get no `href` — the opaque `m<base64(bidder_id)>` slug is non-resolvable
      // (matches the `CompanyListItem.masked` invariant on the leaderboard). Legal entities and
      // consortia keep their round-trippable href so the Sankey remains a navigation surface for
      // the public rows.
      href: agg.masked ? undefined : `/companies/${companySlug(id)}`,
    });
    cy += h + GAP;
  });

  // Ribbons: stack bands within each node (authority side in company-rank order, company side in
  // authority-rank order) so the weave reads cleanly. Bezier through MID_X, like the mock.
  const ordered = [...pairs].sort(
    (p, q) =>
      aPos.get(p.authority_id)!.index - aPos.get(q.authority_id)!.index ||
      cPos.get(p.bidder_id)!.index - cPos.get(q.bidder_id)!.index,
  );
  const ribbons: SankeyRibbon[] = ordered.map((p) => {
    const authorityName = cleanName(p.authority_name);
    const compAggForBidder = compAgg.get(p.bidder_id)!;
    // Use the aggregated masked label (constant across ribbons for a masked bidder) so the
    // ribbon title does not leak the source name on any flow.
    const bidderDisplayName = compAggForBidder.masked
      ? MASKED_NATURAL_PERSON_LABEL
      : entityName(cleanName(p.bidder_name), p.bidder_kind);
    const a = aPos.get(p.authority_id)!;
    const c = cPos.get(p.bidder_id)!;
    const a0 = a.off;
    const a1 = a0 + p.won_eur * scaleA;
    a.off = a1;
    const c0 = c.off;
    const c1 = c0 + p.won_eur * scaleC;
    c.off = c1;
    const ax = A_X + BAR_W;
    return {
      d: `M${ax},${a0.toFixed(1)} C${MID_X},${a0.toFixed(1)} ${MID_X},${c0.toFixed(1)} ${C_X},${c0.toFixed(1)} L${C_X},${c1.toFixed(1)} C${MID_X},${c1.toFixed(1)} ${MID_X},${a1.toFixed(1)} ${ax},${a1.toFixed(1)} Z`,
      title: `${authorityName} → ${bidderDisplayName}: ${money(p.won_eur)} · ${p.contracts} договора`,
      fromName: authorityName,
      toName: bidderDisplayName,
      valueEur: p.won_eur,
      contracts: p.contracts,
    };
  });

  return { viewBox: '-150 -6 990 614', width: 990, height: 614, nodes, ribbons };
}

const DEFAULT_TOP = 20;
const MAX_TOP = 50;
export async function getFlows(db: D1Database, p: FlowsParams): Promise<FlowsData> {
  const requestedTop = Number.isInteger(p.top) ? p.top! : DEFAULT_TOP;
  const top = requestedTop >= 1 && requestedTop <= MAX_TOP ? requestedTop : DEFAULT_TOP;
  const rows = await topPairs(db, p, top);
  const pairs: FlowPair[] = rows.map((r, i) => {
    const authorityName = cleanName(r.authority_name);
    const bidderName = cleanName(r.bidder_name);
    // Privacy (PR #183 review): a sole-trader / natural-person pair reads „Частно лице" on the
    // /flows table and Sankey — same invariant as the leaderboard (rows.ts:86), the contract
    // mapper, and the home single-offer tables. The `bidder_kind !== 'consortium'` guard
    // preserves the consortium shape ("ЕТ X; ООД Y и др."). The bidderSlug is the opaque
    // `m<base64(bidder_id)>` token (non-round-trippable, no ЕИК, no name); the page also gets
    // the `X-Privacy-Mask` marker via the routes layer when ANY pair is masked, so the worker
    // noindexes the .data twin.
    const isNaturalPerson =
      r.bidder_kind !== 'consortium' && isNaturalPersonBidder(bidderName, r.bidder_legal_form);
    const maskedBidderName = isNaturalPerson ? MASKED_NATURAL_PERSON_LABEL : bidderName;
    return {
      rank: i + 1,
      authoritySlug: authoritySlug(r.authority_id),
      authorityName,
      bidderSlug: isNaturalPerson ? maskedCompanySlug(r.bidder_id) : companySlug(r.bidder_id),
      bidderName: maskedBidderName,
      bidderDisplayName: isNaturalPerson
        ? MASKED_NATURAL_PERSON_LABEL
        : entityName(maskedBidderName, r.bidder_kind),
      bidderKind: r.bidder_kind,
      masked: isNaturalPerson,
      wonEur: r.won_eur,
      contracts: r.contracts,
    };
  });

  const sectors = await sectorOptions(db);

  return {
    pairs,
    sankey: buildSankey(rows),
    sectors,
    scope: {
      sector: p.sector ?? null,
      year: p.year ? Number(p.year) : null,
      funding: p.funding ?? 'all',
      top,
    },
  };
}
