import type { ConflictContract, ConflictLink } from '@sigma/api-contract';
import { count, moneyBare } from '@sigma/shared';

// Pure presentation logic for the свързани-лица (conflict-of-interest) surface. Everything the conflict
// routes branch on lives here so the JSX stays a declarative shell (the repo does not render-test
// components — see search.suggest.test.ts) and every decision is unit-covered. NONE of this touches
// related_persons_internal; only PUBLISHED material-ownership links reach the DTO. 'related' links are
// a close relative's stake declared by the official — anonymized as „свързано лице", relative never named.

const RELATION_LABEL: Record<string, string> = {
  owns: 'притежава дял',
  manages: 'управлява',
  'owns+manages': 'притежава дял и управлява',
  related: 'дял на свързано лице', // a close relative's stake — the relative is never named
};

/** Bulgarian label for a declared relation. Unknown values pass through — never invent a stronger claim. */
export function relationLabel(relation: string): string {
  return RELATION_LABEL[relation] ?? relation;
}

/** A family link: the stake is a close relative's, declared by the official. Rendered anonymized —
 *  the official + company + value are shown, the relative only as „свързано лице". */
export function isFamilyLink(link: ConflictLink): boolean {
  return link.relation === 'related';
}

/** /conflicts/official/:slug — the office-holder's page (slug already base64url-encoded). */
export function officialHref(officialSlug: string): string {
  return `/conflicts/official/${officialSlug}`;
}

/** /conflicts/company/:eik — officials with a declared interest in this winner. */
export function companyConflictsHref(eik: string): string {
  return `/conflicts/company/${eik}`;
}

/** /companies/:eik — the winner's spending profile (matched winners always carry a valid ЕИК). */
export function companyProfileHref(eik: string): string {
  return `/companies/${eik}`;
}

/** Contract-activity span for a link: a range, a single year, or „—". */
export function contractYearsLabel(first: string | null, last: string | null): string {
  if (first && last && first !== last) return `${first} – ${last}`;
  return first ?? last ?? '—';
}

/** True when ≥1 of the winner's contracts was signed during the declared-stake window — the actual
 *  conflict. Drives the split display and whether the row's contract list is worth expanding. */
export function hasContemporaneousContracts(link: ConflictLink): boolean {
  return link.contemporaneousContractCount > 0;
}

/** Contract-count cell: „3 от 11" when some contracts fall in the declared window, else the plain total. */
export function contractsCountLabel(link: ConflictLink): string {
  return hasContemporaneousContracts(link)
    ? `${count(link.contemporaneousContractCount)} от ${count(link.contractCount)}`
    : count(link.contractCount);
}

/** Public-funds cell: leads with the conflict-window sum (the figure the „по време на конфликта" question
 *  is about) and keeps the total as context so the row still reconciles to the headline. When no contract
 *  was signed in the window, there is nothing to split — show only the total. */
export function fundsCellLabel(link: ConflictLink): { primary: string; total: string | null } {
  if (hasContemporaneousContracts(link) && link.contemporaneousValueEur != null) {
    return {
      primary: moneyBare(link.contemporaneousValueEur),
      total: moneyBare(link.contractValueEur),
    };
  }
  return { primary: moneyBare(link.contractValueEur), total: null };
}

/** Ratio of conflict-window money to the winner's total, for the magnitude bar — how much of the money
 *  moved while the stake was declared. null when there is nothing meaningful to plot (no in-window
 *  contract, no summable total, or no window sum): the bar simply isn't drawn rather than showing 0/NaN.
 *  The window sum is a subset of the total, so the ratio is clamped to 1 as a guard, never exceeds it. */
export function fundsMagnitude(link: ConflictLink): number | null {
  if (!hasContemporaneousContracts(link)) return null;
  const total = link.contractValueEur;
  const conflict = link.contemporaneousValueEur;
  if (total == null || total <= 0 || conflict == null) return null;
  return Math.min(1, conflict / total);
}

/** The on-demand resource URL for a link's contracts (client-fetched by the expandable row). Keyed on the
 *  URL-safe :scope/:slug/:ЕИК — never the raw link_key, which carries '|' and ':'. :scope (self | family)
 *  is a path segment, so it is part of the cache key and can't be cloaked away. */
export function linkContractsHref(link: ConflictLink): string {
  const scope = isFamilyLink(link) ? 'family' : 'self';
  return `/conflicts/link/${scope}/${link.officialSlug}/${link.eik}/contracts`;
}

// The declared YEARS are when the stake was DISCLOSED (declaration within a month of taking office, then
// annually), NOT when it was acquired or sold — real ownership usually predates the first filing (ТР has the
// true start). So a 'before' contract is not "before the person held the stake", only outside the DISCLOSED
// window; the labels say „деклариран период", never „дял", to avoid implying an ownership boundary we can't prove.
const TEMPORAL_LABEL: Record<ConflictContract['temporal'], string> = {
  contemporaneous: 'в декларирания период',
  before: 'преди декларирания период',
  after: 'след декларирания период',
  unknown: 'без дата',
};

/** Bulgarian tag for a contract's position relative to the DECLARED (disclosure) window — not an ownership
 *  interval. Only 'contemporaneous' is the claimed conflict; the rest are context, never asserted as a conflict. */
export function temporalLabel(t: ConflictContract['temporal']): string {
  return TEMPORAL_LABEL[t] ?? t;
}

/** Split a link's contracts into the conflict-window set and the rest (before/after/undated). The list
 *  arrives contemporaneous-first, so this only groups — it never reorders within a group. */
export function partitionContracts(contracts: ConflictContract[]): {
  inConflict: ConflictContract[];
  outside: ConflictContract[];
} {
  return {
    inConflict: contracts.filter((c) => c.temporal === 'contemporaneous'),
    outside: contracts.filter((c) => c.temporal !== 'contemporaneous'),
  };
}

/** A contract's signing year, or „—" when the source carries no date. */
export function contractYear(c: ConflictContract): string {
  return c.signedAt ? c.signedAt.slice(0, 4) : '—';
}

/** A four-digit year from a source string, or null (never NaN/0): `Number(null)` is 0 and `Number('')`
 *  is 0, both of which would silently plot a bogus year 0 on the timeline. */
function parseYear(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s.slice(0, 4));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface TimelineMark {
  year: number;
  /** Horizontal position along the axis, 0–100. */
  leftPct: number;
  /** True only for a contract signed in the declared-stake window (temporal === 'contemporaneous'). */
  inWindow: boolean;
  /** 0-based rank among marks sharing a year, so the component can fan overlapping dots vertically. */
  stackIndex: number;
}

export interface ContractTimeline {
  marks: TimelineMark[];
  minYear: number;
  maxYear: number;
  /** Year labels along the axis (start … middle years … end), thinned to stay legible on a narrow card. */
  ticks: { year: number; leftPct: number }[];
  /** Declared-stake band edges, 0–100; null when the link carries no declared years to shade. */
  windowStartPct: number | null;
  windowEndPct: number | null;
}

/** Geometry for the per-link timeline: dated contracts as dots + the declared-stake window as a band,
 *  all positioned along a shared year axis so the reader SEES which contracts fall inside the window
 *  (Todor's ask, made visual). Returns null when no contract carries a date — there is nothing to plot,
 *  and the textual in-window/outside split already covers the undated case. Undated contracts are
 *  dropped from the axis (they can't be placed) but remain in the list below it. */
export function contractTimeline(
  link: Pick<ConflictLink, 'firstDeclaredYear' | 'lastDeclaredYear'>,
  contracts: ConflictContract[],
): ContractTimeline | null {
  const dated = contracts
    .map((c) => ({ year: parseYear(c.signedAt), inWindow: c.temporal === 'contemporaneous' }))
    .filter((c): c is { year: number; inWindow: boolean } => c.year != null);
  if (dated.length === 0) return null;

  const ws = parseYear(link.firstDeclaredYear);
  const we = parseYear(link.lastDeclaredYear);
  const years = [
    ...dated.map((c) => c.year),
    ...(ws != null ? [ws] : []),
    ...(we != null ? [we] : []),
  ];
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const span = maxYear - minYear;
  // A zero span (all activity in one year) has no axis to spread across — pin everything to the centre.
  const toPct = (y: number): number => (span === 0 ? 50 : ((y - minYear) / span) * 100);

  const seen = new Map<number, number>();
  const marks: TimelineMark[] = dated
    .sort((a, b) => a.year - b.year)
    .map((c) => {
      const stackIndex = seen.get(c.year) ?? 0;
      seen.set(c.year, stackIndex + 1);
      return { year: c.year, leftPct: toPct(c.year), inWindow: c.inWindow, stackIndex };
    });

  // Year labels: every year when the span is short, thinned to ≤ ~8 labels on longer spans so they stay
  // legible on a narrow card; the end year is always included exactly (not dropped by the step).
  const step = Math.max(1, Math.ceil((span + 1) / 8));
  const ticks: { year: number; leftPct: number }[] = [];
  for (let y = minYear; y <= maxYear; y += step) ticks.push({ year: y, leftPct: toPct(y) });
  if (ticks[ticks.length - 1].year !== maxYear) ticks.push({ year: maxYear, leftPct: 100 });

  // Band edges: both years when the window is a range, one point when only one is known, none otherwise.
  const bandLo = ws ?? we;
  const bandHi = we ?? ws;
  return {
    marks,
    minYear,
    maxYear,
    ticks,
    windowStartPct: bandLo != null ? toPct(bandLo) : null,
    windowEndPct: bandHi != null ? toPct(bandHi) : null,
  };
}

/** /contracts/:id — the contract detail page for a listed contract. */
export function contractHref(c: ConflictContract): string {
  return `/contracts/${c.contractSlug}`;
}

/** True only for an absolute https URL. The „декларация" source link opens in a new tab, so a non-https
 *  (or `javascript:`/`data:`) value must never become an href — defence-in-depth, even though the value is
 *  a hardcoded register.cacbg.bg URL today. */
export function isHttpsUrl(u: string | null | undefined): boolean {
  if (!u) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface AuthorityShare {
  authorityId: string;
  authority: string;
  /** This winner's € from THIS body — sum of all its listed contracts here (all temporal buckets). */
  companyEur: number;
  /** The body's total recorded procurement (authority_totals.spent_eur), the ratio's denominator. */
  authorityTotalEur: number | null;
  /** companyEur / authorityTotalEur, clamped to [0,1]; null when the denominator is missing or ≤0. */
  ratio: number | null;
  /** ≥1 of these contracts falls in the declared-disclosure window — the conflict subset, a row marker. */
  inWindow: boolean;
  contractCount: number;
}

/** Per-awarding-body capture: how big a slice of each authority's recorded procurement went to this winner.
 *  Numerator and denominator share the SAME all-time window — the winner's full contract set at that body vs
 *  the body's total recorded spend — so the share is window-consistent (never an in-window sum over an
 *  all-time base, the framing trap the timeline relabel fixed). `inWindow` only MARKS bodies where a contract
 *  falls in the declared period; it never redefines the ratio. Sorted strongest-share-first (nulls last), so
 *  the body a conflicted winner dominates leads. A null figure counts as 0 — the € never reads as fabricated. */
export function authorityShares(contracts: ConflictContract[]): AuthorityShare[] {
  const byAuthority = new Map<string, AuthorityShare>();
  for (const c of contracts) {
    let row = byAuthority.get(c.authorityId);
    if (!row) {
      row = {
        authorityId: c.authorityId,
        authority: c.authority,
        companyEur: 0,
        authorityTotalEur: c.authorityTotalEur,
        ratio: null,
        inWindow: false,
        contractCount: 0,
      };
      byAuthority.set(c.authorityId, row);
    }
    row.companyEur += c.amountEur ?? 0;
    row.contractCount += 1;
    if (c.temporal === 'contemporaneous') row.inWindow = true;
  }
  const rows = [...byAuthority.values()];
  for (const r of rows) {
    r.ratio =
      r.authorityTotalEur != null && r.authorityTotalEur > 0
        ? Math.min(1, r.companyEur / r.authorityTotalEur)
        : null;
  }
  rows.sort((a, b) => {
    if (a.ratio == null && b.ratio == null) return b.companyEur - a.companyEur;
    if (a.ratio == null) return 1;
    if (b.ratio == null) return -1;
    return b.ratio - a.ratio || b.companyEur - a.companyEur;
  });
  return rows;
}

/** Below this the bar is an invisible sliver and a 1-dp % rounds toward „0,0%" — which next to a real €
 *  capture reads as „no relationship" (the false-negative trap). Show „под 0,1%" instead of a fake zero. */
const TINY_SHARE = 0.001;

export type ShareDisplay =
  | { mode: 'bar'; ratio: number } // a plottable share (≥ 0,1%)
  | { mode: 'tiny' } // a real but sub-0,1% capture — „под 0,1%", never „0%"
  | { mode: 'no-denom' } // the body has no rollup total → no share, just the € figure
  | { mode: 'no-value' }; // no summable € for this body → neither share nor a fake „0 €"

/** How one authority row presents its share. Kept here (not in JSX) so the „0%"-vs-„под 0,1%" and missing-
 *  denominator / missing-value branches are unit-covered and the component stays a declarative switch. */
export function authorityShareDisplay(s: AuthorityShare): ShareDisplay {
  if (s.companyEur === 0) return { mode: 'no-value' };
  if (s.ratio == null) return { mode: 'no-denom' };
  if (s.ratio < TINY_SHARE) return { mode: 'tiny' };
  return { mode: 'bar', ratio: s.ratio };
}

/** Leaderboard headline: total public money to linked winners, counts, and the family (свързано лице)
 *  subset. A null contract value counts as 0 (never NaN) — the money figure must never read as fabricated. */
export function privateOwnershipHeadline(links: ConflictLink[]): {
  linkCount: number;
  officialCount: number;
  totalEur: number;
  contemporaneousEur: number;
  familyLinkCount: number;
  familyEur: number;
} {
  const officials = new Set<string>();
  let totalEur = 0;
  let contemporaneousEur = 0;
  let familyLinkCount = 0;
  let familyEur = 0;
  for (const l of links) {
    officials.add(l.officialSlug);
    totalEur += l.contractValueEur ?? 0;
    contemporaneousEur += l.contemporaneousValueEur ?? 0;
    if (isFamilyLink(l)) {
      familyLinkCount += 1;
      familyEur += l.contractValueEur ?? 0;
    }
  }
  return {
    linkCount: links.length,
    officialCount: officials.size,
    totalEur,
    contemporaneousEur,
    familyLinkCount,
    familyEur,
  };
}
