// Authorities (contracting bodies) — leaderboard + facets + CSV. Default sort/filter reads the
// authority_totals rollup; sector/year/EU cross-cuts fall back to a scoped base aggregation. Detail
// page (getAuthority) is added in phase 2.

import type { AuthorityListItem, FacetCount, Page } from '@sigma/api-contract';
import { CPV_SECTORS } from '@sigma/config';
import { csvCell } from './csv';
import { assertCovers } from './filter-guard';
import { filterSignature, keyset, pageCursors } from './keyset';
import { lookup } from './lookup';
import { toAuthorityListItem, typeLabel, type AuthorityTotalsRow } from './rows';
import { searchMatchQuery } from './search';

export type AuthoritySort = 'spent' | 'count' | 'avg' | 'name';

export interface AuthorityListParams {
  sort?: AuthoritySort;
  types?: string[]; // type_group values
  sectors?: string[];
  years?: string[];
  eu?: 'eu' | 'national' | null;
  q?: string | null;
  cursor?: string | null;
  pageSize?: number;
}

export const AUTHORITY_FILTER_KEYS = [
  'types',
  'sectors',
  'years',
  'eu',
  'q',
] as const satisfies readonly (keyof AuthorityListParams)[];

// Compile-time completeness guard (issue #138 bug class) — see filter-guard.ts. If this line
// errors, add the new filter key to AUTHORITY_FILTER_KEYS.
assertCovers<AuthorityListParams, typeof AUTHORITY_FILTER_KEYS>();

const SORTS: Record<AuthoritySort, { col: string; dir: 'asc' | 'desc' }> = lookup({
  spent: { col: 'spent_eur', dir: 'desc' },
  count: { col: 'contracts', dir: 'desc' },
  avg: { col: 'avg_eur', dir: 'desc' },
  name: { col: 'name', dir: 'asc' },
});

// Collapse an untrusted ?sort value to a known key before it reaches any cache key. See
// normalizeContractSort in contracts.ts for the rationale.
export function normalizeAuthoritySort(value: string | null | undefined): AuthoritySort {
  return value != null && value in SORTS ? (value as AuthoritySort) : 'spent';
}

const qs = (n: number) => Array.from({ length: n }, () => '?').join(', ');

const COLS = `authority_id, name, type_group, settlement, region, spent_eur, contracts, suppliers, avg_eur, primary_sector, eu_eur, first_date, last_date`;

function normalizeEu(eu: unknown): 'eu' | 'national' | null {
  return eu === 'eu' || eu === 'national' ? eu : null;
}

function needsBase(p: AuthorityListParams): boolean {
  return Boolean(p.sectors?.length || p.years?.length || normalizeEu(p.eu));
}

function source(p: AuthorityListParams): { from: string; params: unknown[] } {
  // Keep consumed filter keys in sync with AUTHORITY_FILTER_KEYS and authorityFilterSignature().
  if (!needsBase(p)) return { from: 'authority_totals', params: [] };
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
    SELECT a.id AS authority_id, a.name, a.type_group, a.settlement, a.region,
           SUM(c.amount_eur) AS spent_eur, COUNT(*) AS contracts, COUNT(DISTINCT c.bidder_id) AS suppliers,
           SUM(c.amount_eur) / COUNT(*) AS avg_eur, ${single ? '?' : 'NULL'} AS primary_sector,
           SUM(CASE WHEN c.eu_funded = 1 THEN c.amount_eur ELSE 0 END) AS eu_eur,
           MIN(c.signed_at) AS first_date, MAX(c.signed_at) AS last_date
    FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
    WHERE ${where.join(' AND ')}
    GROUP BY a.id
  )`;
  return { from, params: single ? [single, ...params] : params };
}

function entityWhere(p: AuthorityListParams): { sql: string; params: unknown[] } {
  // Keep consumed filter keys in sync with AUTHORITY_FILTER_KEYS and authorityFilterSignature().
  // The type facet shows all 7 buckets; a filter is only meaningful when a strict subset is selected.
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.types?.length && p.types.length < 7) {
    where.push(`type_group IN (${qs(p.types.length)})`);
    params.push(...p.types);
  }
  const match = searchMatchQuery(p.q ?? '');
  if (match) {
    where.push(
      `authority_id IN (SELECT ref FROM search_index WHERE kind = 'authority' AND search_index MATCH ?)`,
    );
    params.push(match);
  }
  return { sql: where.join(' AND '), params };
}

function authorityFilterSignature(p: AuthorityListParams): string {
  const filters = {
    types: p.types,
    sectors: p.sectors,
    years: p.years,
    eu: normalizeEu(p.eu),
    q: searchMatchQuery(p.q ?? ''),
  } satisfies Record<(typeof AUTHORITY_FILTER_KEYS)[number], unknown>;
  return filterSignature(filters);
}

export async function listAuthorities(
  db: D1Database,
  p: AuthorityListParams,
): Promise<Page<AuthorityListItem>> {
  const sort = SORTS[p.sort as keyof typeof SORTS] ?? SORTS['spent'];
  const pageSize = p.pageSize ?? 25;
  const src = source(p);
  const ew = entityWhere(p);
  const signature = authorityFilterSignature(p);
  const ks = keyset({
    sortCol: sort.col,
    idCol: 'authority_id',
    dir: sort.dir,
    cursor: p.cursor,
    filterSignature: signature,
    allowedSortCols: Object.values(SORTS).map((s) => s.col),
  });
  const conds = [ew.sql, ks.whereSql].filter(Boolean).join(' AND ');

  const sql = `SELECT ${COLS}, ${sort.col} AS sort_value FROM ${src.from}${conds ? ' WHERE ' + conds : ''} ${ks.orderSql} LIMIT ?`;
  const [pageRows, totalRow] = await Promise.all([
    db
      .prepare(sql)
      .bind(...src.params, ...ew.params, ...ks.params, pageSize + 1)
      .all<AuthorityTotalsRow & { sort_value: string | number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${src.from}${ew.sql ? ' WHERE ' + ew.sql : ''}`)
      .bind(...src.params, ...ew.params)
      .first<{ n: number }>(),
  ]);
  const { results } = pageRows;

  const hasMore = results.length > pageSize;
  let rows = results.slice(0, pageSize);
  if (ks.reverse) rows = rows.reverse();

  const cursors = pageCursors({
    rows: rows.map((r) => ({ sortValue: r.sort_value, id: r.authority_id })),
    hasMore,
    incomingCursor: p.cursor,
    cursor: ks.cursor,
    sortToken: ks.cursorToken,
  });
  return { items: rows.map(toAuthorityListItem), total: totalRow?.n ?? 0, ...cursors };
}

export interface AuthorityFacets {
  types: FacetCount[]; // friendly type buckets, count-desc
  sectors: FacetCount[];
}

export async function getAuthorityFacets(db: D1Database): Promise<AuthorityFacets> {
  const typeRows = await db
    .prepare(
      `SELECT COALESCE(type_group, 'друго') AS type_group, COUNT(*) AS n FROM authority_totals GROUP BY COALESCE(type_group, 'друго') ORDER BY n DESC`,
    )
    .all<{ type_group: string; n: number }>();
  const sectorRows = await db
    .prepare(`SELECT division, value_eur FROM sector_totals`)
    .all<{ division: string; value_eur: number }>();

  const types: FacetCount[] = typeRows.results.map((r) => ({
    value: r.type_group,
    label: typeLabel(r.type_group) ?? 'друго',
    count: r.n,
  }));
  const byCode = new Map(sectorRows.results.map((r) => [r.division, r.value_eur]));
  const sectors: FacetCount[] = CPV_SECTORS.map((s) => ({
    value: s.code,
    label: s.short ?? s.label,
    count: byCode.get(s.code) ?? 0,
  }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);
  return { types, sectors };
}

/** Streamed CSV of the authority leaderboard (rollup; honours the type filter). */
export function streamAuthoritiesCsv(db: D1Database, p: AuthorityListParams): Response {
  const src = source(p);
  const ew = entityWhere(p);
  const cols = [
    'eik',
    'name',
    'type_group',
    'settlement',
    'region',
    'spent_eur',
    'contracts',
    'suppliers',
    'avg_eur',
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
      const conds = [ew.sql, 'authority_id > ?'].filter(Boolean).join(' AND ');
      const { results } = await db
        .prepare(`SELECT ${COLS} FROM ${src.from} WHERE ${conds} ORDER BY authority_id LIMIT ?`)
        .bind(...src.params, ...ew.params, afterId, CHUNK)
        .all<AuthorityTotalsRow>();
      if (!results.length) {
        done = true;
        controller.close();
        return;
      }
      let block = '';
      for (const r of results) {
        block +=
          [
            r.authority_id.replace(/^auth:/, ''),
            r.name,
            r.type_group,
            r.settlement,
            r.region,
            r.spent_eur,
            r.contracts,
            r.suppliers,
            Math.round(r.avg_eur),
          ]
            .map(csvCell)
            .join(',') + '\n';
        afterId = r.authority_id;
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
      'Content-Disposition': 'attachment; filename="sigma-authorities.csv"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
