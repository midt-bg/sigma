// Companies (winning bidders) — leaderboard + facets + CSV. The default sort/filter reads the
// company_totals rollup (one indexed scan). A sector/year/EU cross-cut falls back to a scoped base
// aggregation (the documented rare path). The detail page (getCompany) is added in phase 2.

import type { CompanyListItem, EntityKind, FacetCount, Page } from '@sigma/api-contract';
import { CPV_SECTORS, ENTITY_TYPES } from '@sigma/config';
import {
  cleanName,
  isNaturalPersonBidder,
  MASKED_NATURAL_PERSON_LABEL,
} from '@sigma/shared';
import { csvCell } from './csv';
import { filterSignature, keyset, pageCursors } from './keyset';
import { lookup } from './lookup';
import { toCompanyListItem, type CompanyTotalsRow } from './rows';
import { searchMatchQuery } from './search';

export type CompanySort = 'won' | 'count' | 'authorities' | 'name';

export interface CompanyListParams {
  sort?: CompanySort;
  kinds?: EntityKind[];
  countBucket?: string | null;
  sectors?: string[];
  years?: string[];
  eu?: 'eu' | 'national' | null;
  q?: string | null;
  cursor?: string | null;
  pageSize?: number;
}

export const COMPANY_FILTER_KEYS = [
  'kinds',
  'countBucket',
  'sectors',
  'years',
  'eu',
  'q',
] as const satisfies readonly (keyof CompanyListParams)[];

const SORTS: Record<CompanySort, { col: string; dir: 'asc' | 'desc' }> = lookup({
  won: { col: 'won_eur', dir: 'desc' },
  count: { col: 'contracts', dir: 'desc' },
  authorities: { col: 'authorities', dir: 'desc' },
  name: { col: 'name', dir: 'asc' },
});

// Collapse an untrusted ?sort value to a known key before it reaches any cache key. See
// normalizeContractSort in contracts.ts for the rationale.
export function normalizeCompanySort(value: string | null | undefined): CompanySort {
  return value != null && value in SORTS ? (value as CompanySort) : 'won';
}

const COUNT_BUCKETS: Record<string, string> = lookup({
  '1': 'contracts = 1',
  '2-5': 'contracts BETWEEN 2 AND 5',
  '6-20': 'contracts BETWEEN 6 AND 20',
  '21-100': 'contracts BETWEEN 21 AND 100',
  '100+': 'contracts > 100',
});

const qs = (n: number) => Array.from({ length: n }, () => '?').join(', ');

const COLS = `bidder_id, name, kind, ownership_kind, eik, eik_valid, settlement, won_eur, contracts, authorities, primary_sector, eu_eur, first_date, last_date, legal_form`;

function normalizeEu(eu: unknown): 'eu' | 'national' | null {
  return eu === 'eu' || eu === 'national' ? eu : null;
}

function needsBase(p: CompanyListParams): boolean {
  return Boolean(p.sectors?.length || p.years?.length || normalizeEu(p.eu));
}

/**
 * The FROM source: the rollup table, or a scoped base-aggregation CTE for sector/year/EU cross-cuts.
 * Keep consumed filter keys in sync with COMPANY_FILTER_KEYS and companyFilterSignature().
 */
function source(p: CompanyListParams): { from: string; params: unknown[] } {
  if (!needsBase(p))
    return {
      from: `(SELECT ct.*, b.legal_form AS legal_form FROM company_totals AS ct LEFT JOIN bidders AS b ON b.id = ct.bidder_id)`,
      params: [],
    };
  const where: string[] = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  if (p.sectors?.length) {
    where.push(`substr(t.cpv_code, 1, 2) IN (${qs(p.sectors.length)})`);
    params.push(...p.sectors);
  }
  if (p.years?.length) {
    where.push(`substr(c.signed_at, 1, 4) IN (${qs(p.years.length)})`);
    params.push(...p.years);
  }
  const eu = normalizeEu(p.eu);
  if (eu === 'eu') where.push('c.eu_funded = 1');
  else if (eu === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  const single = p.sectors?.length === 1 ? p.sectors[0]! : null;
  const from = `(
    SELECT b.id AS bidder_id, b.name, b.kind, b.ownership_kind, b.eik_normalized AS eik, b.eik_valid, b.settlement,
           b.legal_form AS legal_form,
           SUM(c.amount_eur) AS won_eur, COUNT(*) AS contracts, COUNT(DISTINCT t.authority_id) AS authorities,
           ${single ? '?' : 'NULL'} AS primary_sector,
           SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END) AS eu_eur,
           MIN(c.signed_at) AS first_date, MAX(c.signed_at) AS last_date
    FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id
    WHERE ${where.join(' AND ')}
    GROUP BY b.id
  )`;
  return { from, params: single ? [single, ...params] : params };
}

/**
 * Entity-level WHERE (kind, contract-count bucket) applied on top of the source.
 * Keep consumed filter keys in sync with COMPANY_FILTER_KEYS and companyFilterSignature().
 */
function entityWhere(p: CompanyListParams): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.kinds?.length && p.kinds.length < 2) {
    where.push(`kind = ?`);
    params.push(p.kinds[0]);
  }
  if (p.countBucket && COUNT_BUCKETS[p.countBucket]) where.push(COUNT_BUCKETS[p.countBucket]!);
  const match = searchMatchQuery(p.q ?? '');
  if (match) {
    where.push(
      `bidder_id IN (SELECT ref FROM search_index WHERE kind = 'company' AND search_index MATCH ?)`,
    );
    params.push(match);
  }
  return { sql: where.join(' AND '), params };
}

function companyFilterSignature(p: CompanyListParams): string {
  const filters = {
    kinds: p.kinds,
    countBucket: p.countBucket,
    sectors: p.sectors,
    years: p.years,
    eu: normalizeEu(p.eu),
    q: searchMatchQuery(p.q ?? ''),
  } satisfies Record<(typeof COMPANY_FILTER_KEYS)[number], unknown>;
  return filterSignature(filters);
}

export async function listCompanies(
  db: D1Database,
  p: CompanyListParams,
): Promise<Page<CompanyListItem>> {
  const sort = SORTS[p.sort as keyof typeof SORTS] ?? SORTS['won'];
  const pageSize = p.pageSize ?? 25;
  const src = source(p);
  const ew = entityWhere(p);
  const signature = companyFilterSignature(p);
  const ks = keyset({
    sortCol: sort.col,
    idCol: 'bidder_id',
    dir: sort.dir,
    cursor: p.cursor,
    filterSignature: signature,
    allowedSortCols: Object.values(SORTS).map((s) => s.col),
  });
  const conds = [ew.sql, ks.whereSql].filter(Boolean).join(' AND ');

  const sql = `SELECT ${COLS}, ${sort.col} AS sort_value FROM ${src.from}${conds ? ' WHERE ' + conds : ''} ${ks.orderSql} LIMIT ?`;
  const [pageRows, total] = await Promise.all([
    db
      .prepare(sql)
      .bind(...src.params, ...ew.params, ...ks.params, pageSize + 1)
      .all<CompanyTotalsRow & { sort_value: string | number }>(),
    countCompanies(db, src, ew),
  ]);
  const { results } = pageRows;

  const hasMore = results.length > pageSize;
  let rows = results.slice(0, pageSize);
  if (ks.reverse) rows = rows.reverse();

  const cursors = pageCursors({
    rows: rows.map((r) => ({ sortValue: r.sort_value, id: r.bidder_id })),
    hasMore,
    incomingCursor: p.cursor,
    cursor: ks.cursor,
    sortToken: ks.cursorToken,
  });
  return { items: rows.map(toCompanyListItem), total, ...cursors };
}

async function countCompanies(
  db: D1Database,
  src: { from: string; params: unknown[] },
  ew: { sql: string; params: unknown[] },
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${src.from}${ew.sql ? ' WHERE ' + ew.sql : ''}`)
    .bind(...src.params, ...ew.params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface CompanyFacets {
  kinds: FacetCount[];
  sectors: FacetCount[];
}

export async function getCompanyFacets(db: D1Database): Promise<CompanyFacets> {
  const kindRows = await db
    .prepare(`SELECT kind, COUNT(*) AS n FROM company_totals GROUP BY kind`)
    .all<{ kind: EntityKind; n: number }>();
  const sectorRows = await db
    .prepare(`SELECT division, value_eur FROM sector_totals`)
    .all<{ division: string; value_eur: number }>();

  const byKind = new Map(kindRows.results.map((r) => [r.kind, r.n]));
  const kinds: FacetCount[] = (['company', 'consortium'] as EntityKind[]).map((k) => ({
    value: k,
    label: ENTITY_TYPES[k],
    count: byKind.get(k) ?? 0,
  }));

  const byCode = new Map(sectorRows.results.map((r) => [r.division, r.value_eur]));
  const sectors: FacetCount[] = CPV_SECTORS.map((s) => ({
    value: s.code,
    label: s.short ?? s.label,
    count: byCode.get(s.code) ?? 0,
  }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  return { kinds, sectors };
}

/** Streamed CSV of the company leaderboard (honours the same filters as the list page). */
export function streamCompaniesCsv(db: D1Database, p: CompanyListParams): Response {
  const src = source(p);
  const ew = entityWhere(p);
  const cols = [
    'eik',
    'name',
    'kind',
    'settlement',
    'won_eur',
    'contracts',
    'authorities',
    'primary_sector',
  ];
  const CHUNK = 2000;
  let afterId = '';
  let done = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('﻿' + cols.join(',') + '\n'));
    },
    async pull(controller) {
      if (done) return;
      const conds = [ew.sql, 'bidder_id > ?'].filter(Boolean).join(' AND ');
      const { results } = await db
        .prepare(`SELECT ${COLS} FROM ${src.from} WHERE ${conds} ORDER BY bidder_id LIMIT ?`)
        .bind(...src.params, ...ew.params, afterId, CHUNK)
        .all<CompanyTotalsRow>();
      if (!results.length) {
        done = true;
        controller.close();
        return;
      }
      let block = '';
      for (const r of results) {
        const isNatural = isNaturalPersonBidder(cleanName(r.name), r.legal_form);
        const name = isNatural ? MASKED_NATURAL_PERSON_LABEL : r.name;
        const eik = isNatural ? '' : r.eik;
        block +=
          [
            eik,
            name,
            r.kind,
            r.settlement,
            r.won_eur,
            r.contracts,
            r.authorities,
            r.primary_sector,
          ]
            .map(csvCell)
            .join(',') + '\n';
        afterId = r.bidder_id;
      }
      controller.enqueue(enc.encode(block));
      if (results.length < CHUNK) {
        done = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sigma-companies.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
