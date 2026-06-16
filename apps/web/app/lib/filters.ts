// URLSearchParams ⇄ typed filter state. All list/sort/page state lives in the query string so every
// view has a shareable, reproducible address (a methodology principle). Formatting helpers live in
// @sigma/shared; this module is only about reading/writing the URL.

import { CPV_CATEGORIES, CPV_SECTORS, categoryForDivision } from '@sigma/config';
import type { EntityKind } from '@sigma/api-contract';
import { normalizeCompanySort } from '@sigma/db';
import type { CpvCategory } from '@sigma/config';
import type { FilterCategory, FilterGroup, FilterOption } from '../components/FilterRail';

export const PAGE_SIZE = { contracts: 15, companies: 25, authorities: 25 } as const;
export const MAX_MULTI_VALUES = 50;

const KNOWN_SECTORS = new Set(CPV_SECTORS.map((s) => s.code));

function allowedMulti(key: string, value: string): boolean {
  if (key === 'sector') return KNOWN_SECTORS.has(value);
  return true;
}

/** Parse a repeated/CSV multi-value param (`?year=2025&year=2024` or `?year=2025,2024`) to a string[]. */
export function getMulti(params: URLSearchParams, key: string): string[] {
  const all = params
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(all))
    .filter((v) => allowedMulti(key, v))
    .slice(0, MAX_MULTI_VALUES);
}

export function companyListParams(sp: URLSearchParams) {
  return {
    sort: normalizeCompanySort(sp.get('sort')),
    kinds: getMulti(sp, 'kind') as EntityKind[],
    countBucket: sp.get('count'),
    sectors: getMulti(sp, 'sector'),
    years: getMulti(sp, 'year'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    q: sp.get('q'),
  };
}

export interface SingleSelectFilters {
  sector: string | null;
  year: string | null;
  funding: 'all' | 'eu' | 'national';
  top: number;
  unknownSector: boolean;
  unknownYear: boolean;
}

/**
 * Single-select explorer filters (sector / year / funding / top) shared by the visual pages
 * (/flows, /competition). A bogus ?sector or ?year is flagged and dropped from the params, so the
 * page can show an explicit empty state instead of silently filtering everything out. `years` is the
 * valid set for the current coverage window.
 */
export function singleSelectFilters(sp: URLSearchParams, years: string[]): SingleSelectFilters {
  const sector = sp.get('sector');
  const year = sp.get('year');
  const unknownSector = Boolean(sector) && !KNOWN_SECTORS.has(sector!);
  const unknownYear = Boolean(year) && !years.includes(year!);
  const funding = sp.get('funding');
  return {
    sector: unknownSector ? null : sector,
    year: unknownYear ? null : year,
    funding: funding === 'eu' || funding === 'national' ? funding : 'all',
    top: sp.get('top') === '50' ? 50 : 20,
    unknownSector,
    unknownYear,
  };
}

interface SectorFacet {
  value: string;
  label: string;
  count?: number;
}

export function buildSectorGroup(
  facetSectors: readonly SectorFacet[],
  selected: string[],
): FilterGroup {
  const optionsByCategory = new Map<string, FilterOption[]>();

  for (const sector of facetSectors) {
    const category = categoryForDivision(sector.value);
    if (!category) continue;

    const options = optionsByCategory.get(category.key) ?? [];
    options.push({
      value: sector.value,
      label: sector.label,
      ...(sector.count != null ? { count: sector.count } : {}),
    });
    optionsByCategory.set(category.key, options);
  }

  const categories = CPV_CATEGORIES.flatMap((category: CpvCategory): FilterCategory[] => {
    const options = optionsByCategory.get(category.key);
    if (!options?.length) return [];

    const allCountsPresent = options.every((option) => option.count != null);
    const count = allCountsPresent
      ? options.reduce((sum, option) => sum + (option.count ?? 0), 0)
      : undefined;

    return [
      {
        key: category.key,
        label: category.label,
        ...(count != null ? { count } : {}),
        options,
      },
    ];
  });

  return {
    key: 'sector',
    label: 'Сектор (CPV)',
    type: 'checkbox',
    selected,
    categories,
  };
}

// Canonical serialization order so the same logical state always yields the same URL string —
// good for history/bookmarks/caching. Keys not listed keep their existing relative order, appended
// after the known ones. Filter facets first, then search/sort, then the paging cursor markers.
const PARAM_ORDER = [
  'q',
  'type',
  'kind',
  'sector',
  'year',
  'procedure',
  'funding',
  'eu',
  'value',
  'authority',
  'bidder',
  'top',
  'count',
  'sort',
  'cursor',
  'page',
];

/**
 * Build a new query string from a base, overriding/removing the given keys. Drops empty values and
 * serializes params in a fixed, stable key order regardless of which control changed.
 */
export function withParams(
  base: URLSearchParams,
  overrides: Record<string, string | number | string[] | null | undefined>,
): string {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(overrides)) {
    next.delete(key);
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v) next.append(key, v);
    } else {
      next.set(key, String(value));
    }
  }
  const canonical = new URLSearchParams();
  const order = (key: string) => {
    const i = PARAM_ORDER.indexOf(key);
    return i === -1 ? PARAM_ORDER.length : i;
  };
  const keys = Array.from(new Set(Array.from(next.keys()))).sort((a, b) => order(a) - order(b));
  for (const key of keys) {
    for (const v of next.getAll(key)) if (v !== '') canonical.append(key, v);
  }
  const s = canonical.toString();
  return s ? `?${s}` : '';
}

/** A href with the `sort` swapped (and cursor/page reset — a new sort starts at page 1). */
export function sortHref(base: URLSearchParams, sort: string): string {
  return withParams(base, { sort, cursor: null, page: null });
}

export interface PageNav {
  page: number; // 1-based, for display
  pageCount: number;
  prevHref: string | null;
  nextHref: string | null;
}

export function leaderboardRankOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/** Compute Prev/Next hrefs + page display from keyset cursors and the URL's `page` marker. */
export function pageNav(opts: {
  base: URLSearchParams;
  total: number;
  pageSize: number;
  nextCursor: string | null;
  prevCursor: string | null;
}): PageNav {
  const { base, total, pageSize, nextCursor, prevCursor } = opts;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // ?page is a display/rank marker; real data is cursor-driven. Without a cursor the rows are the
  // first page, so force page 1. Otherwise clamp to the valid range to avoid impossible "N от M".
  const page = !base.get('cursor')
    ? 1
    : Math.min(Math.max(1, Number(base.get('page') ?? '1') || 1), pageCount);
  return {
    page,
    pageCount,
    prevHref:
      page > 1 && prevCursor ? withParams(base, { cursor: prevCursor, page: page - 1 }) : null,
    nextHref: nextCursor ? withParams(base, { cursor: nextCursor, page: page + 1 }) : null,
  };
}
