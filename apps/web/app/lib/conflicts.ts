import type { ConflictContract, ConflictLink } from '@sigma/api-contract';
import { getMulti } from './filters';

// Pure presentation logic for the свързани-лица (conflict-of-interest) surface. Everything the conflict
// routes branch on lives here so the JSX stays a declarative shell (the repo does not render-test
// components — see search.suggest.test.ts) and every decision is unit-covered. NONE of this touches
// related_persons_internal; only PUBLISHED ownership links reach the DTO. A close relative's stake
// (family_ownership, relation 'related') now surfaces identically to a self stake (ADR-0032, superseding
// ADR-0030) — labelled „свързано лице", with the relative never named and the relationship never asserted.

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

/** /persons/:slug — the office-holder's page (slug already base64url-encoded). */
export function officialHref(officialSlug: string): string {
  return `/persons/${encodeURIComponent(officialSlug)}`;
}

/** /companies/:eik — the winner's spending profile (matched winners always carry a valid ЕИК). */
export function companyProfileHref(eik: string): string {
  return `/companies/${encodeURIComponent(eik)}`;
}

/** /contracts/:id — the contract detail page for a listed contract. */
export function contractHref(c: ConflictContract): string {
  return `/contracts/${c.contractSlug}`;
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
 *  „no summable €" (render „—") from a real 0 — the money must never read as fabricated. `groupByPerson`
 *  (row totals, null preserved) reduces this one map. */
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

/** One row of the /conflicts leaderboard: a whole PERSON, collapsed from their per-winner links. The list
 *  USED to render one card per relationship (a person with three winners = three cards); since #287 it is a
 *  DataTable this shape feeds — „one row per лице". Grouping stays in presentation — the loader keeps
 *  returning raw `ConflictLink[]` (plan decision #5).
 *
 *  Deliberately carries NO relative identity. A family link (relation 'related', ADR-0032) folds into the
 *  person's counts and money exactly like a self link, but the relative is never named — this row exposes
 *  only the OFFICIAL (their own public declaration), never who the свързано лице is. */
export interface ConflictPersonRow {
  /** The office-holder's name, from their strongest link (person grain is (name, institution), ADR-0026). */
  official: string;
  /** URL-safe person id → /persons/:slug — the group key. */
  officialSlug: string;
  personIdentity?: string;
  /** The official's latest declared institution — disambiguates namesakes; from the strongest link. */
  institution: string | null;
  /** The official's position, from the same filing as `institution`. */
  position: string | null;
  /** Distinct winner ЕИК the person is linked to. „Дружества" cell shows this, or the name when it is 1. */
  companyCount: number;
  companies?: { company: string; eik: string; self: number; family: number; registry?: number }[];
  /** The single winner's name+ЕИК when companyCount === 1 (issue: „брой, или името, ако е едно"); else null. */
  soleCompany: { company: string; eik: string } | null;
  /** The person's winners' contracts — per-ЕИК-deduped (contract_count is a company-level winner total,
   *  constant within a ЕИК, like the money), null-guarded (never NaN). */
  contractCount: number;
  /** Total public money to the person's winners — per-ЕИК-deduped (a winner's € is company-level,
   *  not per-link; shares `dedupeMoneyPerEik`). NULL — not 0 — when no winner carries a summable value, so the
   *  cell renders „—" like the per-link card rather than a fabricated „0" (niki #312 MEDIUM 3). */
  contractValueEur: number | null;
  /** Conflict-window subset of that money, per-ЕИК-deduped (MAX). NULL when the window carries no
   *  summable € (e.g. in-window contracts with NULL amounts), so the list shows „—", never a fabricated 0. */
  contemporaneousValueEur: number | null;
  /** Whose declared stake(s) this row aggregates: 'self' (own only), 'family' (a close relative's only,
   *  ADR-0032 — relative never named), or 'mixed' (both). Identity-free; drives the „свързано лице" qualifier
   *  so a family-only row is never visually indistinguishable from an own stake (niki #312 MEDIUM 1). */
  stakeKind: 'self' | 'family' | 'mixed' | 'registry';
  /** ≥1 of the person's links has a contract from the official's OWN institution — OR across links. */
  ownInstitution: boolean;
  /** ≥1 contract is signed in an observed year with institution and position data for the person. */
  hasContemporaneous: boolean;
  declaredInstitutions?: DeclaredInstitution[];
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
    const identity = l.registryPersonId ?? l.officialSlug;
    const g = groups.get(identity);
    if (!g) {
      groups.set(identity, { strongest: l, links: [l] });
    } else {
      g.links.push(l);
      if (isStrongerLink(l, g.strongest)) g.strongest = l;
    }
  }

  const rows: { row: ConflictPersonRow; strongest: ConflictLink }[] = [];
  for (const { strongest, links: groupLinks } of groups.values()) {
    // Per-ЕИК money dedup. Null-aware: a per-ЕИК value contributes only when
    // non-null, and the row stays NULL when NO winner carries a summable value — so „—", not a fabricated „0".
    const perEik = dedupeMoneyPerEik(
      groupLinks.map((l) => ({
        ...l,
        contemporaneousValueEur: l.personCompanyValueEur ?? l.contemporaneousValueEur,
      })),
    );
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
        personIdentity: strongest.registryPersonId ?? strongest.officialSlug,
        institution: strongest.institution,
        position: strongest.position,
        companyCount,
        soleCompany,
        companies: [...new Set(groupLinks.map((l) => l.eik))].map((eik) => ({
          eik,
          company: groupLinks.find((l) => l.eik === eik)!.company,
          self: Number(groupLinks.some((l) => l.eik === eik && l.relation === 'owns')),
          family: Number(groupLinks.some((l) => l.eik === eik && l.relation === 'related')),
        })),
        contractCount,
        contractValueEur,
        contemporaneousValueEur,
        stakeKind,
        ownInstitution: groupLinks.some((l) => l.ownInstitution),
        hasContemporaneous: groupLinks.some((l) => l.contemporaneousContractCount > 0),
        declaredInstitutions: groupDeclaredInstitutions(
          groupLinks.flatMap((l) =>
            l.declaredOffices?.length
              ? l.declaredOffices
              : [{ institution: l.institution ?? '', position: l.position, year: null }],
          ),
        ),
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

/** „Позиция · институция" — the two facts that say which official this is, in one line, wherever a name is
 *  shown. Null when neither is on record. */
export function officialRole(o: {
  position: string | null;
  institution: string | null;
}): string | null {
  const parts = [o.position, o.institution].map((s) => s?.trim()).filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// ── /conflicts list filters ────────────────────────────────────────────────────────────────────────
// The whole surfaced set is loaded (≤1000 links), so the list filters, sorts and pages in memory: the same
// rows on the server render and in the browser, and no extra query per filter.

export type ConflictStakeFilter = 'self' | 'family' | 'registry';
export type ConflictSignal = 'own' | 'window';
export type ConflictSort = 'period' | 'total' | 'contracts';

export interface ConflictListFilters {
  stake: ConflictStakeFilter | null;
  signals: ConflictSignal[];
  /** Institution keys (see `institutionKey`). */
  institutions: string[];
  sort: ConflictSort;
  q: string | null;
}

/** The /conflicts filter state from the URL. A value it does not know is dropped, not an error. */
export function conflictListFilters(sp: URLSearchParams): ConflictListFilters {
  const stake = sp.get('stake');
  const sort = sp.get('sort');
  return {
    stake: stake === 'self' || stake === 'family' || stake === 'registry' ? stake : null,
    signals: getMulti(sp, 'signal').filter(
      (s): s is ConflictSignal => s === 'own' || s === 'window',
    ),
    institutions: getMulti(sp, 'institution').map(institutionKey).filter(Boolean),
    sort: sort === 'total' || sort === 'contracts' ? sort : 'period',
    q: sp.get('q')?.trim() || null,
  };
}

/** One spelling-insensitive key per institution, so „Община Ямбол" and „ОБЩИНА ЯМБОЛ" filter together. */
export function institutionKey(name: string | null | undefined): string {
  let value = (name ?? '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('bg');
  if (/[А-Я]/u.test(value)) {
    const lookalikes: Record<string, string> = {
      A: 'А',
      B: 'В',
      C: 'С',
      E: 'Е',
      H: 'Н',
      K: 'К',
      M: 'М',
      O: 'О',
      P: 'Р',
      T: 'Т',
      X: 'Х',
      Y: 'У',
    };
    value = value.replace(/[ABCEHKMOPTXY]/g, (c) => lookalikes[c]!);
  }
  return value;
}

export interface DeclaredInstitution {
  institution: string;
  positions: string[];
  years: string[];
}

/** Years are observations in declarations, never an inferred continuous mandate. */
export function groupDeclaredInstitutions(
  offices: {
    institution: string | null;
    position: string | null;
    year: string | null;
  }[],
): DeclaredInstitution[] {
  const groups = new Map<string, DeclaredInstitution>();
  for (const o of offices) {
    const key = institutionKey(o.institution);
    if (!key || !o.institution) continue;
    const g = groups.get(key) ?? { institution: o.institution, positions: [], years: [] };
    const position = o.position?.trim();
    if (position && !g.positions.some((p) => institutionKey(p) === institutionKey(position)))
      g.positions.push(position);
    if (o.year && /^\d{4}$/.test(o.year) && !g.years.includes(o.year)) g.years.push(o.year);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, years: g.years.sort(), positions: g.positions.sort() }))
    .sort(
      (a, b) =>
        (b.years.at(-1) ?? '').localeCompare(a.years.at(-1) ?? '') ||
        a.institution.localeCompare(b.institution, 'bg'),
    );
}

const rowInstitutions = (r: ConflictPersonRow): DeclaredInstitution[] =>
  r.declaredInstitutions?.length
    ? r.declaredInstitutions
    : r.institution
      ? [{ institution: r.institution, positions: r.position ? [r.position] : [], years: [] }]
      : [];

const matchText = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg');

/** The rows the filters keep. A person with both an own and a relative's stake ('mixed') answers both
 *  stake filters; every chosen signal must hold; the search matches the name, position or institution. */
export function filterConflictRows(
  rows: ConflictPersonRow[],
  f: ConflictListFilters,
): ConflictPersonRow[] {
  const q = f.q ? matchText(f.q) : null;
  const institutions = new Set(f.institutions);
  return rows.filter(
    (r) =>
      (f.stake == null || r.stakeKind === 'mixed' || r.stakeKind === f.stake) &&
      (!f.signals.includes('own') || r.ownInstitution) &&
      (!f.signals.includes('window') || r.hasContemporaneous) &&
      (institutions.size === 0 ||
        rowInstitutions(r).some((i) => institutions.has(institutionKey(i.institution)))) &&
      (q == null ||
        matchText(
          `${r.official} ${r.position ?? ''} ${r.institution ?? ''} ${rowInstitutions(r)
            .map((i) => `${i.institution} ${i.positions.join(' ')}`)
            .join(' ')}`,
        ).includes(q)),
  );
}

/** Each named sort is monotonic by its displayed figure; unknown amounts come last. */
export function sortConflictRows(
  rows: ConflictPersonRow[],
  sort: ConflictSort,
): ConflictPersonRow[] {
  const key = (r: ConflictPersonRow) =>
    sort === 'period'
      ? (r.contemporaneousValueEur ?? -1)
      : sort === 'total'
        ? (r.contractValueEur ?? -1)
        : r.contractCount;
  return [...rows].sort(
    (a, b) =>
      key(b) - key(a) ||
      (a.officialSlug < b.officialSlug ? -1 : a.officialSlug > b.officialSlug ? 1 : 0),
  );
}

/** The institution options for the filter rail: the officials' institutions by how many persons each
 *  carries — the top ones, plus any already selected — each under its most common spelling. */
export function institutionOptions(
  rows: ConflictPersonRow[],
  selected: string[],
  top = 12,
): { value: string; label: string; count: number }[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const r of rows) {
    for (const { institution } of rowInstitutions(r)) {
      const key = institutionKey(institution);
      if (!key) continue;
      const e = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      e.count++;
      e.spellings.set(institution, (e.spellings.get(institution) ?? 0) + 1);
      byKey.set(key, e);
    }
  }
  const ranked = [...byKey.entries()].sort(
    (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1),
  );
  const keep = new Set([...ranked.slice(0, top).map(([k]) => k), ...selected]);
  return ranked
    .filter(([k]) => keep.has(k))
    .map(([value, e]) => ({
      value,
      label: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      count: e.count,
    }));
}
