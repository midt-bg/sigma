import type { ConflictContract, ConflictContractFacts, ConflictLink } from '@sigma/api-contract';
import { count, moneyBare } from '@sigma/shared';

// Pure presentation logic for the свързани-лица (conflict-of-interest) surface. Everything the conflict
// routes branch on lives here so the JSX stays a declarative shell (the repo does not render-test
// components — see search.suggest.test.ts) and every decision is unit-covered. NONE of this touches
// related_persons_internal; only PUBLISHED ownership links reach the DTO. A close relative's stake
// (family_ownership, relation 'related') now surfaces identically to a self stake (ADR-0032, superseding
// ADR-0030) — labelled „свързано лице", with the relative never named and the relationship never asserted.

// Tense-NEUTRAL labels: the surface never asserts CURRENT ownership (a stake declared years ago may have
// been sold — the declared window dates it, the divestment blind spot). „притежава/управлява"
// (present tense — „owns/manages") would read a possibly-terminated stake as current. „дялово участие" is
// the КПКОНПИ declaration's OWN column term („Размер на дяловото участие"), a fact about the declaration,
// not a present-tense claim — paired with the „деклариран … г." dating on the card.
const RELATION_LABEL: Record<string, string> = {
  owns: 'дялово участие',
  manages: 'управление',
  'owns+manages': 'дялово участие и управление',
  // A close relative's declared stake (ADR-0032): shown identically to a self stake, but marked as a свързано
  // лице — the relative is never named and the relationship type is never asserted. „деклариран" (declared,
  // not „притежава") keeps it tense-neutral, matching the self labels. Todor's exact ADR-0032 wording.
  related: 'деклариран дял на свързано лице',
};

/** Bulgarian label for a declared relation. Unknown values pass through — never invent a stronger claim. */
/**
 * How the company's identity was established, in the register's own terms (#279, ADR-0033).
 *
 * Deliberately does NOT say the official owns anything: „вписан съдружник/собственик" reports what the
 * act RECORDS, while the ownership claim itself comes from the official's own declaration and is
 * rendered separately as „дялово участие". „Потвърдено" means the company was identified by a fact the
 * official declared — the seat or the ЕИК — not that anybody was found in the act.
 */
export function registryEvidenceLabel(l: {
  evidenceKind: 'document' | 'confirmed';
  registryRole: 'owner' | 'manager' | null;
}): string {
  if (l.evidenceKind === 'confirmed') return 'самоличност, потвърдена по декларирани данни';
  return l.registryRole === 'manager'
    ? 'лицето е вписано като управител'
    : 'лицето е вписано като съдружник/собственик';
}

export function relationLabel(relation: string): string {
  return RELATION_LABEL[relation] ?? relation;
}

/**
 * How to describe a PAGE's set of links in prose (#279 §2.6). The card labels above are already
 * family-aware; the surrounding page copy was not, and asserted „собствен дял" — an OWN stake — above
 * cards that correctly read „свързано лице". On a family-only page that is a false claim about the named
 * official, and it is the second source of truth the card-label fix set out to remove.
 *
 * Derived from the links themselves rather than passed in, so a page cannot describe a set it isn't
 * rendering. Mixed sets get the neutral wording: it is the only phrasing true of every card.
 */
export function declaredStakeNoun(links: { relation: string }[]): string {
  const anyFamily = links.some((l) => l.relation === 'related');
  const anySelf = links.some((l) => l.relation !== 'related');
  if (anyFamily && !anySelf) return 'дял на свързано лице';
  if (anyFamily && anySelf) return 'деклариран дял — собствен или на свързано лице';
  return 'собствен дял';
}

// Defense in depth: the slug is base64url and the ЕИК numeric today (so encoding is a no-op), but if either
// assumption ever drifts, an un-escaped `/`, `?` or `#` would break routing and the cache key. Escape the
// dynamic segments unconditionally (ydimitrof #226, conflicts.ts).

/** /conflicts/official/:slug — the office-holder's page (slug already base64url-encoded). */
export function officialHref(officialSlug: string): string {
  return `/conflicts/official/${encodeURIComponent(officialSlug)}`;
}

/** /conflicts/company/:eik — officials with a declared interest in this winner. */
export function companyConflictsHref(eik: string): string {
  return `/conflicts/company/${encodeURIComponent(eik)}`;
}

/** /companies/:eik — the winner's spending profile (matched winners always carry a valid ЕИК). */
export function companyProfileHref(eik: string): string {
  return `/companies/${encodeURIComponent(eik)}`;
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

export interface FundsCell {
  primary: string;
  total: string | null;
}

/** The lead/total funds split shared by the per-link cell and the per-person row: lead with the
 *  conflict-window sum (the figure the „по време на конфликта" question is about) and keep the total as „от"
 *  context so it still reconciles to the headline; when there is no in-window sum to split, show only the total. */
function fundsSplit(
  hasWindow: boolean,
  windowEur: number | null,
  totalEur: number | null,
): FundsCell {
  if (hasWindow && windowEur != null) {
    return { primary: moneyBare(windowEur), total: moneyBare(totalEur) };
  }
  return { primary: moneyBare(totalEur), total: null };
}

/** Public-funds cell for a single link. Leads with the conflict-window sum and keeps the total as context so
 *  the row still reconciles to the headline. When no contract was signed in the window, show only the total. */
export function fundsCellLabel(link: ConflictLink): FundsCell {
  return fundsSplit(
    hasContemporaneousContracts(link),
    link.contemporaneousValueEur,
    link.contractValueEur,
  );
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

/** The declared-window mark for one contract against ONE link's window — moved client-side (#312 HIGH 1) so
 *  the eager DTO can carry a winner's contract FACTS once per ЕИК and each link derive its own `temporal`.
 *  Mirrors the SQL `LINK_CONTRACTS_SQL` CASE / IN_WINDOW: 'unknown' when the signed year or either declared
 *  bound is missing/unparseable (via `parseYear`'s NaN/≤0 guard — so a non-ISO date is 'unknown', matching
 *  `strftime` returning NULL); else 'before'/'after'/'contemporaneous' by inclusive [first, last]. */
export function contractTemporal(
  signedAt: string | null,
  firstDeclaredYear: string | null,
  lastDeclaredYear: string | null,
): ConflictContract['temporal'] {
  const y = parseYear(signedAt);
  const lo = parseYear(firstDeclaredYear);
  const hi = parseYear(lastDeclaredYear);
  if (y == null || lo == null || hi == null) return 'unknown';
  if (y < lo) return 'before';
  if (y > hi) return 'after';
  return 'contemporaneous';
}

/** Mark a winner's shared contract FACTS against ONE link's declared window, contemporaneous-first — the
 *  per-link view the detail block renders from the ЕИК-deduped facts. The facts arrive union-window-first from
 *  the read (so the server cap kept the in-window ones); this stable sort promotes THIS link's in-window subset
 *  to the top while preserving the read's signed_at DESC order within each group. */
export function markContracts(
  facts: ConflictContractFacts[],
  firstDeclaredYear: string | null,
  lastDeclaredYear: string | null,
): ConflictContract[] {
  return facts
    .map((f) => ({
      ...f,
      temporal: contractTemporal(f.signedAt, firstDeclaredYear, lastDeclaredYear),
    }))
    .sort(
      (a, b) =>
        (a.temporal === 'contemporaneous' ? 0 : 1) - (b.temporal === 'contemporaneous' ? 0 : 1),
    );
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
  /** companyEur / authorityTotalEur, clamped to [0,1]; null when the numerator or denominator is missing or ≤0
   *  (a 0-€ row renders as no-value, so it must also sort as no-value — ydimitrof #226). */
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
      r.companyEur > 0 && r.authorityTotalEur != null && r.authorityTotalEur > 0
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

/** MAX of two nullable numbers, treating null as ABSENT (not 0): the result is null only when BOTH are. */
function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** Per-ЕИК money dedup — the ONE copy of the invariant that guards a published sum (niki #312 MEDIUM 7).
 *  Money is a COMPANY-level quantity keyed on ЕИК, not per-link. NOT_REDUNDANT_FAMILY collapses only a SAME
 *  official's own + relative stake in one winner; TWO DIFFERENT officials linked to the same winner both reach
 *  the link array, so a plain per-link sum double-counts that winner's € once per extra official (+8,1% /
 *  ~7,9M € on the full corpus, #226). `contract_value_eur` is the winner's total (constant within a ЕИК → MAX
 *  IS the value, exact dedup); `contemporaneous_value_eur` is a per-link WINDOW subset that can differ between
 *  officials on the same winner (IN_WINDOW keys on the link's declared years), so MAX per ЕИК is deterministic
 *  and never overstated. Null-aware: a ЕИК whose links carry only null values stays null, so a caller can tell
 *  „no summable €" (render „—") from a real 0 — the money must never read as fabricated. `conflictHeadline`
 *  (grand totals, nulls→0) and `groupByPerson` (row totals, null preserved) both reduce this one map. */
export function dedupeMoneyPerEik(
  links: Pick<ConflictLink, 'eik' | 'contractValueEur' | 'contemporaneousValueEur'>[],
): Map<string, { total: number | null; contemporaneous: number | null }> {
  const perEik = new Map<string, { total: number | null; contemporaneous: number | null }>();
  for (const l of links) {
    const prev = perEik.get(l.eik) ?? { total: null, contemporaneous: null };
    perEik.set(l.eik, {
      total: maxNullable(prev.total, l.contractValueEur),
      contemporaneous: maxNullable(prev.contemporaneous, l.contemporaneousValueEur),
    });
  }
  return perEik;
}

/** Leaderboard headline: total public money to linked winners and counts, over the whole published surface —
 *  self and family stakes alike (ADR-0032). Grand totals coerce a missing winner value to 0 (never NaN) — a
 *  leaderboard sum is always a number; linkCount/officialCount stay per-link/per-official. */
export function conflictHeadline(links: ConflictLink[]): {
  linkCount: number;
  officialCount: number;
  totalEur: number;
  contemporaneousEur: number;
} {
  const officials = new Set(links.map((l) => l.officialSlug));
  const perEik = dedupeMoneyPerEik(links);
  let totalEur = 0;
  let contemporaneousEur = 0;
  for (const v of perEik.values()) {
    totalEur += v.total ?? 0;
    contemporaneousEur += v.contemporaneous ?? 0;
  }
  return {
    linkCount: links.length,
    officialCount: officials.size,
    totalEur,
    contemporaneousEur,
  };
}

/** One row of the /conflicts leaderboard: a whole PERSON, collapsed from their per-winner links. The list
 *  USED to render one card per relationship (a person with three winners = three cards); since #287 it is a
 *  DataTable this shape feeds — „one row per лице". Grouping stays in presentation — the loader keeps
 *  returning raw `ConflictLink[]` (plan decision #5), mirroring how `conflictHeadline` also groups read-time.
 *
 *  Deliberately carries NO relative identity. A family link (relation 'related', ADR-0032) folds into the
 *  person's counts and money exactly like a self link, but the relative is never named — this row exposes
 *  only the OFFICIAL (their own public declaration), never who the свързано лице is. */
export interface ConflictPersonRow {
  /** The office-holder's name, from their strongest link (person grain is (name, institution), ADR-0026). */
  official: string;
  /** URL-safe person id → /conflicts/official/:slug — the group key. */
  officialSlug: string;
  /** The official's latest declared institution — disambiguates namesakes; from the strongest link. */
  institution: string | null;
  /** Distinct winner ЕИК the person is linked to. „Дружества" cell shows this, or the name when it is 1. */
  companyCount: number;
  /** The single winner's name+ЕИК when companyCount === 1 (issue: „брой, или името, ако е едно"); else null. */
  soleCompany: { company: string; eik: string } | null;
  /** The person's winners' contracts — per-ЕИК-deduped (contract_count is a company-level winner total,
   *  constant within a ЕИК, like the money), null-guarded (never NaN). */
  contractCount: number;
  /** Total public money to the person's winners — per-ЕИК-deduped „от" figure (a winner's € is company-level,
   *  not per-link; shares `dedupeMoneyPerEik`). NULL — not 0 — when no winner carries a summable value, so the
   *  cell renders „—" like the per-link card rather than a fabricated „0" (niki #312 MEDIUM 3). */
  contractValueEur: number | null;
  /** Conflict-window subset of that money (the „по време на конфликта" lead figure), per-ЕИК-deduped (MAX).
   *  NULL when the window carries no summable € (e.g. in-window contracts with NULL amounts), so `personFundsCell`
   *  suppresses the split exactly as `fundsCellLabel`'s `!= null` guard does — never „0 … от 88 млн.". */
  contemporaneousValueEur: number | null;
  /** Whose declared stake(s) this row aggregates: 'self' (own only), 'family' (a close relative's only,
   *  ADR-0032 — relative never named), or 'mixed' (both). Identity-free; drives the „свързано лице" qualifier
   *  so a family-only row is never visually indistinguishable from an own stake (niki #312 MEDIUM 1). */
  stakeKind: 'self' | 'family' | 'mixed';
  /** ≥1 of the person's links has a contract from the official's OWN institution — OR across links. */
  ownInstitution: boolean;
  /** ≥1 of the person's links has a contract signed in the declared window — OR across links. */
  hasContemporaneous: boolean;
}

/** Public-funds cell for a collapsed person row (#287): the same lead/total split as the per-link
 *  `fundsCellLabel`, but computed from the row's OR-ed window flag and per-ЕИК-deduped sums — no synthetic
 *  `ConflictLink` and no cast, so it cannot silently drift if `fundsCellLabel` grows a new field read. */
export function personFundsCell(
  row: Pick<
    ConflictPersonRow,
    'hasContemporaneous' | 'contemporaneousValueEur' | 'contractValueEur'
  >,
): FundsCell {
  return fundsSplit(row.hasContemporaneous, row.contemporaneousValueEur, row.contractValueEur);
}

/** The NEXUS_ORDER key of a SINGLE link, as an orderable tuple (strongest first). Mirrors the DB's
 *  `own_institution='exact' DESC, contemporaneous_contract_count>0 DESC, contemporaneous_value_eur DESC,
 *  link_key` (`related-persons.ts`), so „strongest link" here means exactly what the query means by it. */
function linkRank(l: ConflictLink): [number, number, number, string] {
  return [
    l.ownInstitution ? 1 : 0,
    l.contemporaneousContractCount > 0 ? 1 : 0,
    l.contemporaneousValueEur ?? 0,
    l.linkKey,
  ];
}

/** True when link `a` is STRICTLY stronger than `b` under NEXUS_ORDER (own-institution, then any-window,
 *  then window-€; the link_key tiebreak is ascending — the smaller key is „stronger" only as a stable
 *  deterministic tiebreak, matching the DB's `link_key` ASC). */
function isStrongerLink(a: ConflictLink, b: ConflictLink): boolean {
  const [ai, ac, av] = linkRank(a);
  const [bi, bc, bv] = linkRank(b);
  if (ai !== bi) return ai > bi;
  if (ac !== bc) return ac > bc;
  if (av !== bv) return av > bv;
  return a.linkKey < b.linkKey; // ascending link_key is the DB's final tiebreak
}

/** Collapse per-relationship `ConflictLink[]` into one `ConflictPersonRow` per person for the /conflicts
 *  leaderboard (#287). Grouped by `officialSlug`.
 *
 *  Correctness invariants (plan §3.1):
 *  - Identity (official/slug/institution) comes from the person's STRONGEST link, computed explicitly via
 *    NEXUS_ORDER — NOT `links[0]`. The DB returns links pre-sorted so `links[0]` is strongest in practice,
 *    but this helper must be correct for ANY input order, so it never assumes the caller sorted.
 *  - Money is per-ЕИК-deduped via the shared `dedupeMoneyPerEik`: a winner's total € is company-level and
 *    constant within a ЕИК (exact dedup); the window € is a per-link subset, so take the MAX per ЕИК. Within
 *    one person the ЕИК are already distinct after the upstream family collapse, but a duplicate ЕИК must still
 *    not double-count — the dedup guarantees it. Null-preserving: a row with no summable € stays NULL (→ „—"),
 *    never a fabricated 0.
 *  - `companyCount` = distinct ЕИК; `soleCompany` carries the name+ЕИК when that count is 1.
 *  - `contractCount` = per-ЕИК-deduped (company-level winner total, like the money), null-guarded.
 *  - Flags are OR-ed across links; but the RANK is driven by the strongest SINGLE link, not the OR-ed flags
 *    (else two weak links out-rank one strong link). Output rows are sorted by the strongest link's
 *    NEXUS_ORDER: ownInstitution DESC, hasContemporaneous DESC, maxContemporaneousValueEur DESC, then a
 *    stable tiebreak on `officialSlug`. */
export function groupByPerson(links: ConflictLink[]): ConflictPersonRow[] {
  const groups = new Map<string, { strongest: ConflictLink; links: ConflictLink[] }>();
  for (const l of links) {
    const g = groups.get(l.officialSlug);
    if (!g) {
      groups.set(l.officialSlug, { strongest: l, links: [l] });
    } else {
      g.links.push(l);
      if (isStrongerLink(l, g.strongest)) g.strongest = l;
    }
  }

  const rows: { row: ConflictPersonRow; strongest: ConflictLink }[] = [];
  for (const { strongest, links: groupLinks } of groups.values()) {
    // Per-ЕИК money dedup (shared with conflictHeadline). Null-aware: a per-ЕИК value contributes only when
    // non-null, and the row stays NULL when NO winner carries a summable value — so „—", not a fabricated „0".
    const perEik = dedupeMoneyPerEik(groupLinks);
    let contractValueEur: number | null = null;
    let contemporaneousValueEur: number | null = null;
    for (const v of perEik.values()) {
      if (v.total != null) contractValueEur = (contractValueEur ?? 0) + v.total;
      if (v.contemporaneous != null)
        contemporaneousValueEur = (contemporaneousValueEur ?? 0) + v.contemporaneous;
    }

    const companyCount = perEik.size;
    // soleCompany takes the strongest link's winner when the person has exactly one distinct ЕИК — every
    // link then shares that ЕИК, so the strongest link's company/eik is the right (and only) one to name.
    const soleCompany =
      companyCount === 1 ? { company: strongest.company, eik: strongest.eik } : null;

    // contract_count is ALSO a company-level winner total (constant within a ЕИК, like contract_value_eur), so
    // dedup it per ЕИК — not a raw link sum. NOT_REDUNDANT_FAMILY makes ≤1 link per (official, ЕИК) today, so
    // sum == dedup in practice; deduping keeps the count defended against a duplicate ЕИК exactly as the money
    // is, removing the guardian asymmetry (niki #312 MEDIUM 7). Null-guarded (never NaN).
    const contractCountPerEik = new Map<string, number>();
    for (const l of groupLinks) {
      contractCountPerEik.set(
        l.eik,
        Math.max(contractCountPerEik.get(l.eik) ?? 0, l.contractCount ?? 0),
      );
    }
    let contractCount = 0;
    for (const n of contractCountPerEik.values()) contractCount += n;

    // Identity-free stake provenance: 'family' only when EVERY link is a relative's (relation 'related'),
    // 'self' when none is, 'mixed' otherwise. Mirrors declaredStakeNoun's split — never names the relative.
    const anyFamily = groupLinks.some((l) => l.relation === 'related');
    const anySelf = groupLinks.some((l) => l.relation !== 'related');
    const stakeKind: ConflictPersonRow['stakeKind'] = anyFamily
      ? anySelf
        ? 'mixed'
        : 'family'
      : 'self';

    rows.push({
      strongest,
      row: {
        official: strongest.official,
        officialSlug: strongest.officialSlug,
        institution: strongest.institution,
        companyCount,
        soleCompany,
        contractCount,
        contractValueEur,
        contemporaneousValueEur,
        stakeKind,
        ownInstitution: groupLinks.some((l) => l.ownInstitution),
        hasContemporaneous: groupLinks.some((l) => l.contemporaneousContractCount > 0),
      },
    });
  }

  // Rank is the strongest SINGLE link's NEXUS_ORDER — NOT the OR-ed row flags. A person with one strong link
  // and one weak link must not sink below a person with only a medium link, so compare the STRONGEST links
  // directly. `isStrongerLink` already breaks every tie on `link_key` ASC (globally unique), so two distinct
  // persons are ALWAYS strictly ordered — the `officialSlug` comparison below is an unreachable belt-and-braces
  // fallback (it would only fire if two persons' strongest links shared a link_key, which cannot happen), kept
  // so the comparator is total even under a future non-unique key (ydimitrof #312 LOW 1).
  rows.sort((a, b) => {
    if (isStrongerLink(a.strongest, b.strongest)) return -1;
    if (isStrongerLink(b.strongest, a.strongest)) return 1;
    return a.row.officialSlug < b.row.officialSlug
      ? -1
      : a.row.officialSlug > b.row.officialSlug
        ? 1
        : 0;
  });
  return rows.map((r) => r.row);
}
