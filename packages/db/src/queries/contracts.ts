// Contracts — the atomic record. The list reads the base `contracts` table (filtered/sorted, keyset
// page of 15); facet counts are grouped or read from facet_counts; CSV is streamed.

import type { ContractListItem, FacetCount, Page } from '@sigma/api-contract';
import { CPV_SECTORS, PROCEDURE_GROUPS, procedureGroup } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { csvCell } from './csv';
import { assertCovers } from './filter-guard';
import { authoritySlug, bidderIdFromSlug, companySlug, contractSlug } from './identity';
import { filterSignature, keyset, pageCursors } from './keyset';
import { lookup } from './lookup';
import { searchMatchQuery } from './search';

export type ContractSort = 'value-desc' | 'value-asc' | 'date-desc' | 'date-asc';

export interface ContractListParams {
  sort?: ContractSort;
  years?: string[];
  sectors?: string[];
  procedureGroups?: string[];
  valueBucket?: string | null;
  eu?: 'eu' | 'national' | null;
  authority?: string | null; // authority ЕИК (slug)
  bidder?: string | null; // bidder slug
  q?: string | null;
  bids?: 'one' | null;
  cursor?: string | null;
  pageSize?: number;
}

export const CONTRACT_FILTER_KEYS = [
  'years',
  'sectors',
  'procedureGroups',
  'valueBucket',
  'eu',
  'authority',
  'bidder',
  'q',
  'bids',
] as const satisfies readonly (keyof ContractListParams)[];

// Compile-time completeness guard (issue #138 bug class) — see filter-guard.ts. If this line
// errors, add the new filter key to CONTRACT_FILTER_KEYS.
assertCovers<ContractListParams, typeof CONTRACT_FILTER_KEYS>();

const SORTS: Record<ContractSort, { expr: string; dir: 'asc' | 'desc' }> = lookup({
  'value-desc': { expr: 'COALESCE(c.amount_eur, -1)', dir: 'desc' },
  'value-asc': { expr: 'COALESCE(c.amount_eur, 1e18)', dir: 'asc' },
  'date-desc': { expr: "COALESCE(c.signed_at, '')", dir: 'desc' },
  'date-asc': { expr: "COALESCE(c.signed_at, '9999-99')", dir: 'asc' },
});

// Collapse an untrusted ?sort value to a known key (default otherwise). The query layer already
// falls back internally, but callers must normalize before the value reaches a cache key (edge or
// the CSV R2 object key) — an unvalidated sort would mint unbounded distinct keys for identical
// content. `value in SORTS` is null-prototype-safe (see lookup()).
export function normalizeContractSort(value: string | null | undefined): ContractSort {
  return value != null && value in SORTS ? (value as ContractSort) : 'value-desc';
}

// A real signed_at year is YYYY at the head of the date; everything else (null, empty, malformed)
// lands in the "unknown" bucket, whose facet value/filter token is this sentinel (a non-empty string
// so it survives the URL round-trip — getMulti drops falsy tokens).
const YEAR_KNOWN = "substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'";
const YEAR_UNKNOWN = 'unknown';

const VALUE_BUCKETS: Record<string, [number, number | null]> = lookup({
  lt100k: [0, 100_000],
  '100k-1m': [100_000, 1_000_000],
  '1m-10m': [1_000_000, 10_000_000],
  '10m-100m': [10_000_000, 100_000_000],
  gt100m: [100_000_000, null],
});

const qs = (n: number) => Array.from({ length: n }, () => '?').join(', ');

interface ContractRow {
  id: string;
  subject: string;
  unp: string;
  cpv_code: string | null;
  eu_funded: number | null;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  procedure_type: string;
  signed_at: string | null;
  bids_received: number | null;
  amount_eur: number | null;
}

const SELECT = `
  SELECT c.id, COALESCE(NULLIF(c.contract_subject, ''), t.title) AS subject, t.source_id AS unp,
         t.cpv_code, c.eu_funded, t.authority_id, a.name AS authority_name,
         c.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind,
         t.procedure_type, c.signed_at, c.bids_received, c.amount_eur`;
const FROM = `
  FROM contracts c
  JOIN tenders t ON t.id = c.tender_id
  JOIN authorities a ON a.id = t.authority_id
  JOIN bidders b ON b.id = c.bidder_id`;

/**
 * Build the WHERE fragment (with a leading ' WHERE ') + params shared by list, summary and CSV.
 * Keep consumed filter keys in sync with CONTRACT_FILTER_KEYS and contractFilterSignature().
 */
function buildFilters(p: ContractListParams): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.years?.length) {
    // The "Неизвестна" bucket (sentinel) matches null/malformed dates — the complement of YEAR_KNOWN.
    const realYears = p.years.filter((y) => y !== YEAR_UNKNOWN);
    const wantUnknown = realYears.length !== p.years.length;
    const ors: string[] = [];
    if (realYears.length) {
      ors.push(`substr(c.signed_at, 1, 4) IN (${qs(realYears.length)})`);
      params.push(...realYears);
    }
    // `NOT (GLOB)` is NULL (falsy) for a NULL signed_at, so spell out the NULL case to match the facet.
    if (wantUnknown) {
      ors.push(
        `(c.signed_at IS NULL OR NOT (${YEAR_KNOWN}) OR CAST(substr(c.signed_at, 1, 4) AS INTEGER) > ?)`,
      );
      params.push(new Date().getUTCFullYear());
    }
    if (ors.length) where.push(ors.length > 1 ? `(${ors.join(' OR ')})` : ors.join(''));
  }
  if (p.sectors?.length) {
    where.push(`substr(t.cpv_code, 1, 2) IN (${qs(p.sectors.length)})`);
    params.push(...p.sectors);
  }
  if (p.procedureGroups?.length) {
    const types = p.procedureGroups.flatMap(
      (k) => PROCEDURE_GROUPS.find((g) => g.key === k)?.types ?? [],
    );
    if (types.length) {
      where.push(`t.procedure_type IN (${qs(types.length)})`);
      params.push(...types);
    }
  }
  const bucket = p.valueBucket ? VALUE_BUCKETS[p.valueBucket] : undefined;
  if (bucket) {
    const [lo, hi] = bucket;
    where.push(hi == null ? `c.amount_eur >= ?` : `(c.amount_eur >= ? AND c.amount_eur < ?)`);
    params.push(lo);
    if (hi != null) params.push(hi);
  }
  if (p.eu === 'eu') where.push(`c.eu_funded = 1`);
  else if (p.eu === 'national') where.push(`(c.eu_funded IS NULL OR c.eu_funded = 0)`);
  if (p.bids === 'one') where.push(`c.bids_received = 1`);
  if (p.authority) {
    where.push(`t.authority_id = ?`);
    params.push('auth:' + p.authority);
  }
  if (p.bidder) {
    const id = bidderIdFromSlug(p.bidder);
    if (id) {
      where.push(`c.bidder_id = ?`);
      params.push(id);
    } else {
      where.push('1=0');
    }
  }
  const match = searchMatchQuery(p.q ?? '');
  if (match) {
    where.push(
      `c.id IN (SELECT ref FROM search_index WHERE kind = 'contract' AND search_index MATCH ?)`,
    );
    params.push(match);
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function contractFilterSignature(p: ContractListParams): string {
  const bidder = p.bidder ? (bidderIdFromSlug(p.bidder) ?? `invalid:${p.bidder}`) : null;
  const filters = {
    years: p.years,
    sectors: p.sectors,
    procedureGroups: p.procedureGroups,
    valueBucket: p.valueBucket,
    eu: p.eu,
    authority: p.authority,
    bidder,
    q: searchMatchQuery(p.q ?? ''),
    bids: p.bids ?? null,
  } satisfies Record<(typeof CONTRACT_FILTER_KEYS)[number], unknown>;
  return filterSignature(filters);
}

function toItem(r: ContractRow): ContractListItem {
  const authorityName = cleanName(r.authority_name);
  const bidderName = cleanName(r.bidder_name);
  return {
    id: contractSlug(r.id),
    subject: r.subject,
    unp: r.unp,
    sectorCode: r.cpv_code ? r.cpv_code.slice(0, 2) : null,
    euFunded: r.eu_funded === 1,
    isConsortium: r.bidder_kind === 'consortium',
    authoritySlug: authoritySlug(r.authority_id),
    authorityName,
    bidderSlug: companySlug(r.bidder_id),
    bidderName,
    bidderDisplayName: entityName(bidderName, r.bidder_kind),
    bidderKind: r.bidder_kind,
    procedureLabel: procedureGroup(r.procedure_type).label,
    signedAt: r.signed_at,
    bidsReceived: r.bids_received,
    valueEur: r.amount_eur,
  };
}

/**
 * Single-offer contracts (`bids_received = 1`) excluding suspect values — for the homepage section.
 * `mode` picks recency vs highest value. Reuses the shared SELECT/FROM and the row mapper.
 */
export async function listSingleOfferContracts(
  db: D1Database,
  mode: 'recent' | 'value',
  limit = 10,
): Promise<ContractListItem[]> {
  const order =
    mode === 'value'
      ? 'ORDER BY c.amount_eur DESC'
      : 'ORDER BY COALESCE(c.signed_at, c.published_at) DESC';
  const rows = await db
    .prepare(
      `${SELECT} ${FROM} WHERE c.bids_received = 1 AND c.value_flag = 'ok' AND c.amount_eur > 0 ${order}, c.id LIMIT ?`,
    )
    .bind(limit)
    .all<ContractRow>();
  return rows.results.map(toItem);
}

export interface ContractListResult extends Page<ContractListItem> {
  valueEur: number;
  suspect: number;
}

export async function listContracts(
  db: D1Database,
  p: ContractListParams,
  // The caller may inject a (cached) summary to skip the COUNT/SUM scan — see apps/web KV caching.
  summaryOverride?: { total: number; valueEur: number; suspect: number },
): Promise<ContractListResult> {
  const sort = SORTS[p.sort as keyof typeof SORTS] ?? SORTS['value-desc'];
  const pageSize = p.pageSize ?? 15;
  const filters = buildFilters(p);
  const signature = contractFilterSignature(p);
  const ks = keyset({
    sortCol: sort.expr,
    idCol: 'c.id',
    dir: sort.dir,
    cursor: p.cursor,
    filterSignature: signature,
    allowedSortCols: Object.values(SORTS).map((s) => s.expr),
  });

  const conds = [filters.sql ? filters.sql.slice(7) : '', ks.whereSql]
    .filter(Boolean)
    .join(' AND ');
  const sql = `${SELECT}, ${sort.expr} AS sort_value ${FROM}${conds ? ' WHERE ' + conds : ''} ${ks.orderSql} LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...filters.params, ...ks.params, pageSize + 1)
    .all<ContractRow & { sort_value: string | number }>();

  const hasMore = results.length > pageSize;
  let rows = results.slice(0, pageSize);
  if (ks.reverse) rows = rows.reverse();

  const summary = summaryOverride ?? (await contractsSummary(db, p));
  const cursors = pageCursors({
    rows: rows.map((r) => ({ sortValue: r.sort_value, id: r.id })),
    hasMore,
    incomingCursor: p.cursor,
    cursor: ks.cursor,
    sortToken: ks.cursorToken,
  });

  return {
    items: rows.map(toItem),
    total: summary.total,
    valueEur: summary.valueEur,
    suspect: summary.suspect,
    nextCursor: cursors.nextCursor,
    prevCursor: cursors.prevCursor,
  };
}

/** Total rows, clean-EUR sum and suspect tally for the current filter (the list headline). */
export async function contractsSummary(
  db: D1Database,
  p: ContractListParams,
): Promise<{ total: number; valueEur: number; suspect: number }> {
  const filters = buildFilters(p);
  // suspect badge = rows whose value is excluded from the sum (amount_eur IS NULL: value_/annex_suspect)
  // PLUS value_low rows, which ARE summed (amount_eur populated) but stay labelled „непотвърдена стойност".
  // The value SUM intentionally keeps value_low IN (amount_eur is non-null for it) and only drops
  // value_/annex_suspect (their amount_eur is NULL upstream).
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(c.amount_eur), 0) AS eur,
              SUM(CASE WHEN c.amount_eur IS NULL OR c.value_flag = 'value_low' THEN 1 ELSE 0 END) AS suspect ${FROM}${filters.sql}`,
    )
    .bind(...filters.params)
    .first<{ total: number; eur: number; suspect: number }>();
  return { total: row?.total ?? 0, valueEur: row?.eur ?? 0, suspect: row?.suspect ?? 0 };
}

export interface ContractFacets {
  years: FacetCount[];
  procedures: FacetCount[]; // folded into the 7 @sigma/config groups
  sectors: FacetCount[]; // present sectors, by contract count
  eu: { all: number; eu: number; national: number };
}

/**
 * Rail facets for the contracts list. Procedure/EU come from precomputed counts (no scans).
 * The year facet is computed live from `contracts` so its buckets reconcile with the contracts total:
 * the precomputed `facet_counts` year rows are clamped to a fixed date window and drop outlier years
 * (2016/2019/2029) plus null/malformed dates, which silently hid ~36 rows. This grouped scan rides the
 * `signed_at` index and yields every real year, plus a "Неизвестна" bucket for null/unparseable dates.
 */
export async function getContractFacets(db: D1Database): Promise<ContractFacets> {
  const facetRows = await db
    .prepare(`SELECT facet, key, contracts FROM facet_counts`)
    .all<{ facet: string; key: string; contracts: number }>();
  const sectorRows = await db
    .prepare(
      `SELECT substr(t.cpv_code, 1, 2) AS division, COUNT(*) AS contracts
       FROM contracts c JOIN tenders t ON t.id = c.tender_id
       GROUP BY division`,
    )
    .all<{ division: string; contracts: number }>();
  const yearRows = await db
    .prepare(
      `SELECT CASE WHEN ${YEAR_KNOWN} THEN substr(c.signed_at, 1, 4) ELSE '${YEAR_UNKNOWN}' END AS key,
              COUNT(*) AS contracts
       FROM contracts c GROUP BY key`,
    )
    .all<{ key: string; contracts: number }>();
  const rows = facetRows.results;

  const currentYear = new Date().getUTCFullYear();
  const yearBuckets = new Map<string, number>();
  for (const r of yearRows.results) {
    const year = Number(r.key);
    const key = r.key === YEAR_UNKNOWN || year > currentYear ? YEAR_UNKNOWN : r.key;
    yearBuckets.set(key, (yearBuckets.get(key) ?? 0) + r.contracts);
  }

  const years = Array.from(yearBuckets, ([key, contracts]) => ({ key, contracts }))
    // Real years descend (newest first); the "Неизвестна" bucket sinks to the bottom of the list.
    .sort((a, b) =>
      a.key === YEAR_UNKNOWN ? 1 : b.key === YEAR_UNKNOWN ? -1 : b.key.localeCompare(a.key),
    )
    .map((r) => ({
      value: r.key,
      label: r.key === YEAR_UNKNOWN ? 'Неизвестна' : r.key,
      count: r.contracts,
    }));

  const procByGroup = new Map<string, number>();
  for (const r of rows.filter((r) => r.facet === 'procedure')) {
    const g = procedureGroup(r.key).key;
    procByGroup.set(g, (procByGroup.get(g) ?? 0) + r.contracts);
  }
  const procedures = PROCEDURE_GROUPS.map((g) => ({
    value: g.key,
    label: g.label,
    count: procByGroup.get(g.key) ?? 0,
  })).filter((f) => f.count > 0);

  const sectorByCode = new Map(sectorRows.results.map((r) => [r.division, r.contracts]));
  const sectors = CPV_SECTORS.map((s) => ({
    value: s.code,
    label: s.short ?? s.label,
    count: sectorByCode.get(s.code) ?? 0,
  }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  const euRows = rows.filter((r) => r.facet === 'eu');
  const euYes = euRows.find((r) => r.key === '1')?.contracts ?? 0;
  const euNo = euRows.find((r) => r.key === '0')?.contracts ?? 0;

  return { years, procedures, sectors, eu: { all: euYes + euNo, eu: euYes, national: euNo } };
}

// ── CSV export — streamed (never buffered): keyset-walks the filtered set in 1k-row chunks ─────────

const CSV_COLUMNS = [
  'id',
  'unp',
  'subject',
  'authority',
  'authority_eik',
  'contractor',
  'contractor_eik',
  'kind',
  'sector_code',
  'procedure',
  'signed_at',
  'value_eur',
  'eu_funded',
  'bids_received',
] as const;

interface CsvRow extends ContractRow {
  rowid: number;
  authority_eik: string;
  contractor_eik: string | null;
}

/** A streamed text/csv Response honouring the same filters; a 190k-row export never materialises. */
export function streamContractsCsv(db: D1Database, p: ContractListParams): Response {
  const filters = buildFilters(p);
  const CHUNK = 1000;
  let afterRowid = 0;
  let done = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('﻿' + CSV_COLUMNS.join(',') + '\n'));
    },
    async pull(controller) {
      if (done) return;
      const where = filters.sql ? filters.sql + ' AND c.rowid > ?' : ' WHERE c.rowid > ?';
      const sql = `${SELECT}, c.rowid AS rowid, a.bulstat AS authority_eik, b.eik_normalized AS contractor_eik
        ${FROM}${where} ORDER BY c.rowid LIMIT ?`;
      const { results } = await db
        .prepare(sql)
        .bind(...filters.params, afterRowid, CHUNK)
        .all<CsvRow>();
      if (results.length === 0) {
        done = true;
        controller.close();
        return;
      }
      let block = '';
      for (const r of results) {
        block +=
          [
            contractSlug(r.id),
            r.unp,
            r.subject,
            cleanName(r.authority_name),
            r.authority_eik,
            entityName(cleanName(r.bidder_name), r.bidder_kind),
            r.contractor_eik,
            r.bidder_kind,
            r.cpv_code ? r.cpv_code.slice(0, 2) : '',
            procedureGroup(r.procedure_type).label,
            r.signed_at,
            r.amount_eur,
            r.eu_funded === 1 ? '1' : '0',
            r.bids_received,
          ]
            .map(csvCell)
            .join(',') + '\n';
        afterRowid = r.rowid;
      }
      controller.enqueue(encoder.encode(block));
      if (results.length < CHUNK) {
        done = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sigma-contracts.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
