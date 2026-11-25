import { identityInstitution } from './institution';

/**
 * A person's public offices as the declarations show them — one rule for every page that names a position.
 *
 * What a declaration proves is narrow, and the words follow it:
 *  - An office is known by YEAR. A filing that names an institution and a position is evidence for its
 *    declared year and nothing finer; a filing date is never turned into a mandate date, and a year with no
 *    filing is not filled in. Consecutive years with filings read as one span („2019–2021"), a gap stays a gap.
 *  - „Бивш" belongs to ONE office (an institution, with its positions) and needs a declaration on leaving it
 *    (type `Vacate`) that nothing later reopens: no entry declaration after it and no filing for a later year
 *    in the same institution. An entry in the same year that cannot be dated after the exit (no date on
 *    either, or the same day — a re-election files both) leaves the end unestablished.
 *  - Without that, the end is unknown and the words say only what is on record: the last year with a filing.
 *    The absence of a newer filing does not prove leaving; the absence of an exit declaration does not prove
 *    a current mandate. Nothing here ever says „настоящ".
 *  - Different institutions stay separate offices, and one institution left and later entered again shows
 *    its periods separately.
 *
 * Institutions fold by `identityInstitution`, the same key the list's filter uses — a fold that cannot join two
 * different bodies. Positions inside one institution are listed, not given statuses of their own: a position's
 * spelling varies between filings, and a per-position „бивш" would call somebody former in a post they still
 * file for under another spelling.
 */

/** One filing's office facts. `type` is the register's declaration type (`Entry`, `Annualy`, `Change`,
 *  `Vacate`, `interests`); `declaredOn` the document's date, used only to order an exit against an entry. */
export interface OfficeFiling {
  institution: string | null;
  position: string | null;
  year: string | null;
  type?: string | null;
  declaredOn?: string | null;
}

/** Years with filings inside one period, as spans of consecutive years. */
export interface OfficePeriod {
  /** Ascending, each `[first, last]` (equal for a single year). */
  spans: [string, string][];
  /** The period closes with a declaration on leaving that nothing reopens. */
  ended: boolean;
}

export type OfficeStatus =
  /** A declaration on leaving, for `year`, and nothing later in the institution. */
  | { kind: 'former'; year: string }
  /** The end is not established; `lastYear` is the latest year with a filing. */
  | { kind: 'unknown'; lastYear: string }
  /** No filing with a usable year. */
  | { kind: 'undated' };

export interface PublicOffice {
  institution: string;
  positions: string[];
  periods: OfficePeriod[];
  status: OfficeStatus;
}

const YEAR = /^\d{4}$/;
const kindOf = (type: string | null | undefined): 'entry' | 'exit' | 'other' => {
  const t = type?.trim().toLowerCase();
  return t === 'vacate' ? 'exit' : t === 'entry' ? 'entry' : 'other';
};
const dayOf = (on: string | null | undefined): string | null => {
  const day = on?.trim().slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

interface Dated {
  year: string;
  kind: 'entry' | 'exit' | 'other';
  day: string | null;
}

/** Does `entry` (same year as `exit`) provably come after the exit? Both must be dated, the entry later. */
const provablyAfter = (entry: Dated, exit: Dated): boolean =>
  !!entry.day && !!exit.day && entry.day > exit.day;
/** Could `entry` (same year as `exit`) come after it — i.e. it is not provably before? */
const possiblyAfter = (entry: Dated, exit: Dated): boolean =>
  !(entry.day && exit.day && entry.day < exit.day);

/** Is the exit `exit` reopened by any filing of the same institution? */
function reopened(exit: Dated, filings: Dated[]): boolean {
  return filings.some(
    (f) =>
      f !== exit &&
      (f.year > exit.year ||
        (f.kind === 'entry' && f.year === exit.year && possiblyAfter(f, exit))),
  );
}

function spansOf(years: string[]): [string, string][] {
  const spans: [string, string][] = [];
  for (const y of [...new Set(years)].sort()) {
    const last = spans.at(-1);
    if (last && Number(y) === Number(last[1]) + 1) last[1] = y;
    else if (!last || last[1] !== y) spans.push([y, y]);
  }
  return spans;
}

function periodsOf(filings: Dated[]): OfficePeriod[] {
  const years = [...new Set(filings.map((f) => f.year))].sort();
  const periods: { years: string[]; ended: boolean }[] = [{ years: [], ended: false }];
  for (const year of years) {
    const current = periods.at(-1)!;
    current.years.push(year);
    const inYear = filings.filter((f) => f.year === year);
    // The latest exit of the year that no later year reopens closes the period here; an entry of the same
    // year dated after it opens the next period in the same year, an undated one leaves the end open.
    const exits = inYear.filter((f) => f.kind === 'exit');
    if (!exits.length) continue;
    const later = years.some((y) => y > year);
    const exit = exits.reduce((a, b) => ((b.day ?? '') > (a.day ?? '') ? b : a));
    const entries = inYear.filter((f) => f.kind === 'entry' && possiblyAfter(f, exit));
    if (entries.length === 0) {
      current.ended = true;
      if (later) periods.push({ years: [], ended: false });
    } else if (entries.every((e) => provablyAfter(e, exit))) {
      current.ended = true;
      periods.push({ years: [year], ended: false });
    }
  }
  const last = periods.at(-1)!;
  if (!last.years.length) periods.pop();
  // Only the final period's end is a status claim; it holds exactly when the latest exit is not reopened.
  return periods.map((p) => ({ spans: spansOf(p.years), ended: p.ended }));
}

/**
 * The offices in a person's filings, most recent first. Duplicate filings (the same person read through two
 * aliases or two list parts) count once. Years after `currentYear` are typing errors in the source and are
 * ignored.
 */
export function describeOffices(
  filings: OfficeFiling[],
  currentYear: number = new Date().getUTCFullYear(),
): PublicOffice[] {
  const groups = new Map<
    string,
    { institution: string; positions: Map<string, string>; dated: Dated[]; seen: Set<string> }
  >();
  for (const f of filings) {
    const institution = f.institution?.trim();
    const key = identityInstitution(institution);
    if (!institution || !key) continue;
    const g = groups.get(key) ?? {
      institution,
      positions: new Map<string, string>(),
      dated: [],
      seen: new Set<string>(),
    };
    groups.set(key, g);
    const position = f.position?.trim();
    if (position) {
      const pk = identityInstitution(position) || position;
      if (!g.positions.has(pk)) g.positions.set(pk, position);
    }
    const year = f.year?.trim() ?? '';
    if (!YEAR.test(year) || Number(year) > currentYear) continue;
    const d: Dated = { year, kind: kindOf(f.type), day: dayOf(f.declaredOn) };
    const id = `${d.year}|${d.kind}|${d.day ?? ''}`;
    if (g.seen.has(id)) continue;
    g.seen.add(id);
    g.dated.push(d);
  }
  return [...groups.values()]
    .map((g): PublicOffice => {
      const positions = [...g.positions.values()].sort((a, b) => a.localeCompare(b, 'bg'));
      if (!g.dated.length)
        return { institution: g.institution, positions, periods: [], status: { kind: 'undated' } };
      const exits = g.dated.filter((f) => f.kind === 'exit');
      const latestExit = exits.length
        ? exits.reduce((a, b) =>
            b.year > a.year || (b.year === a.year && (b.day ?? '') > (a.day ?? '')) ? b : a,
          )
        : null;
      const lastYear = g.dated.reduce((y, f) => (f.year > y ? f.year : y), '');
      const former = latestExit !== null && !reopened(latestExit, g.dated);
      const periods = periodsOf(g.dated);
      const last = periods.at(-1);
      if (last) last.ended = former;
      return {
        institution: g.institution,
        positions,
        periods,
        status: former ? { kind: 'former', year: latestExit.year } : { kind: 'unknown', lastYear },
      };
    })
    .sort(
      (a, b) =>
        lastYearOf(b).localeCompare(lastYearOf(a)) ||
        a.institution.localeCompare(b.institution, 'bg'),
    );
}

const lastYearOf = (o: PublicOffice): string =>
  o.status.kind === 'former' ? o.status.year : o.status.kind === 'unknown' ? o.status.lastYear : '';

/** „2015–2019, 2021; 2022–2023" — spans inside a period by commas, periods by semicolons. */
export function officePeriodsText(o: PublicOffice): string {
  return o.periods
    .map((p) => p.spans.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', '))
    .join('; ');
}

/** The status in words: never „настоящ", and „бивш" only with an exit declaration nothing reopens. */
export function officeStatusText(o: PublicOffice): string | null {
  switch (o.status.kind) {
    case 'former':
      return `Бивш: декларация при освобождаване за ${o.status.year} г.`;
    case 'unknown':
      return `Последна декларация за ${o.status.lastYear} г.`;
    default:
      return null;
  }
}

/** „бивш кмет" when the office is former, the position as filed otherwise. One position, or null. */
export function officeTitle(o: PublicOffice): string | null {
  if (!o.positions.length) return null;
  const words = o.positions.join('; ');
  return o.status.kind === 'former'
    ? `бивш ${words.charAt(0).toLowerCase()}${words.slice(1)}`
    : words;
}

/** „2019–2021, 2023" — a set of years as spans of consecutive years. */
export function yearsText(years: string[]): string {
  return spansOf(years)
    .map(([a, b]) => (a === b ? a : `${a}–${b}`))
    .join(', ');
}

/**
 * The years with a filing for the office in which a role dated `from`–`to` was also in force (`to` null: the
 * role is still registered). A co-occurrence by YEAR — the office is known by year, so this never proves both
 * were held on the same day, and an office with no dated filing shares no year.
 */
export function sharedOfficeYears(
  o: PublicOffice,
  from: string,
  to: string | null,
  currentYear: number = new Date().getUTCFullYear(),
): string[] {
  const start = Number(from.slice(0, 4));
  const end = to ? Number(to.slice(0, 4)) : currentYear;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return o.periods
    .flatMap((p) => p.spans)
    .flatMap(([a, b]) => {
      const years: string[] = [];
      for (let y = Math.max(Number(a), start); y <= Math.min(Number(b), end); y++)
        years.push(String(y));
      return years;
    })
    .filter((y, i, all) => all.indexOf(y) === i);
}

/**
 * A person's offices in one line, for a search hit: the latest office — „бивш" only when the rule allows —
 * its institution and the years with filings, then how many more offices there are.
 * „бивш кмет · Община Тестово · декларации за 2015–2019 · още 1 длъжност".
 */
export function officesLine(offices: PublicOffice[]): string | null {
  const [o] = offices;
  if (!o) return null;
  const periods = officePeriodsText(o);
  const parts = [
    officeTitle(o),
    o.institution,
    periods ? `декларации за ${periods}` : null,
    offices.length > 1
      ? `още ${offices.length - 1} ${offices.length === 2 ? 'длъжност' : 'длъжности'}`
      : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
