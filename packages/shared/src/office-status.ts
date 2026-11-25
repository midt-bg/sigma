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
 *
 * One office under two spellings. „Месторабота" is free text, so one body arrives as an abbreviation in one
 * filing and in full in the next, with a typo, or as a bare „Общински съвет". Left apart, the same office is
 * shown twice and the two lines contradict each other: the exit declaration closes one spelling while the
 * other still reads as open. Here — for the WORDS only, never for identity — two spellings join when the names
 * are compatible (`sameBodySpelling`) AND the filings name the same position AND their years touch. All three:
 * a likeness of names alone joins a court with its namesake in the next town, a position alone joins two
 * boards somebody sits on at once.
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
  /** The institution as most of the filings spell it. */
  institution: string;
  /** Every spelling the filings use for it, `institution` first. */
  spellings: string[];
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

/** The capital's municipality and its council, the one municipality whose name is not „Община <място>". */
const CAPITAL = /^(?:СТОЛИЧНА ОБЩИНА|СТОЛИЧЕН ОБЩИНСКИ СЪВЕТ)$/u;
/** The National Assembly under a number or an everyday name. */
const ASSEMBLY =
  /^(?:(?:\d+|[XХIVLМ]+)\s*-?\s*(?:[А-Я]{1,4}\s+)?)?(?:НАРОДНО СЪБРАНИЕ|ПАРЛАМЕНТ)$/u;

/** The key an office is grouped by: the identity key, plus the folds above that it has no reason to know. */
function officeKey(name: unknown): string {
  const key = identityInstitution(name);
  if (CAPITAL.test(key)) return 'СТОЛИЧНА ОБЩИНА';
  if (ASSEMBLY.test(key)) return 'НАРОДНО СЪБРАНИЕ';
  return key;
}

/** Words that qualify a body's name without naming it: a place marker, a preposition, a legal form. */
const FILLER = new Set('ГРАД ГР НА ЗА ПО НАД ПРИ КЪМ И ЕАД АД ЕООД ООД'.split(' '));
/** A municipal council by its generic name, with or without a place after it. */
const COUNCIL = /^(?:ОБЩИНСКИ СЪВЕТ|ОЩИНСКИ СЪВЕТ|ОБС|ОС)(?:\s+|$)/u;
/** The National Assembly as filings write it: abbreviated, numbered before or after, „на РБ". */
const ASSEMBLY_LOOSE =
  /^(?:(?:\d+|[XХIVLМ]+)\s*-?\s*(?:ТО|ТИ|МО|ВО|РО)?\s*)?(?:НС|НАРОДНО СЪБРАНИЕ|ПАРЛАМЕНТ)(?:\s*\d+|\s+(?:НА\s+)?Р\s?Б(?:ЪЛГАРИЯ)?)?$/u;
const LEGAL_FORM = /(?:ЕАД|АД|ЕООД|ООД)$/u;

/** A key with the shorthand of the filings written out, for comparing two spellings. */
const written = (key: string): string =>
  ASSEMBLY_LOOSE.test(key)
    ? 'НАРОДНО СЪБРАНИЕ'
    : key === 'СОС' || CAPITAL.test(key)
      ? 'СТОЛИЧНА ОБЩИНА'
      : key
          .replace(/(\d)(?=[А-Я])/gu, '$1 ')
          .replace(/(?<![0-9A-ZА-Я])Р\s?[-–]?\s?Н(?![0-9A-ZА-Я])/gu, 'РАЙОН')
          .replace(/(?<![0-9A-ZА-Я])(?:СВ|СВЕТИ|СВЕТА)(?![0-9A-ZА-Я])/gu, 'СВ');

/** The words that name the body; initials typed apart („В. Ф.") read as one word. */
function wordsOf(key: string): string[] {
  const words: string[] = [];
  let initials = false;
  for (const w of key.split(/[^0-9A-ZА-Я]+/u)) {
    if (!w || FILLER.has(w)) continue;
    const initial = /^[A-ZА-Я]$/u.test(w);
    if (initial && initials) words[words.length - 1] += w;
    else words.push(w);
    initials = initial;
  }
  return words;
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length]!;
}

/** `short` with one of its words read as the initials of a run of words in `long`: „НС" and „Народно събрание". */
function abbreviates(short: string[], long: string[]): boolean {
  return short.some((word, at) => {
    if (word.length > 8 || /\d/.test(word)) return false;
    const rest = [...short.slice(0, at), ...short.slice(at + 1)];
    for (let from = 0; from + word.length <= long.length; from++) {
      const run = long.slice(from, from + word.length);
      if (run.map((w) => w[0]).join('') !== word) continue;
      const others = [...long.slice(0, from), ...long.slice(from + word.length)];
      if (others.length === rest.length && others.every((w, i) => w === rest[i])) return true;
    }
    return false;
  });
}

/**
 * Could two institution keys be one body written two ways? Deliberately loose — it is only ever asked of two
 * offices of ONE person that also share a position and touching years. Numbers must agree: a unit, a school or
 * an assembly is told apart by its number.
 */
export function sameBodySpelling(a: string, b: string): boolean {
  if (a === b) return true;
  const bare = (k: string): string => k.replace(COUNCIL, '').trim();
  // A bare „Общински съвет" names no place of its own; with one, the council is its municipality.
  if ((COUNCIL.test(a) && !bare(a)) || (COUNCIL.test(b) && !bare(b))) return true;
  // The same for a bare „Областна администрация" beside an oblast.
  const oblast = (k: string, other: string): boolean =>
    k === 'ОБЛАСТНА АДМИНИСТРАЦИЯ' && other.startsWith('ОБЛАСТ ');
  if (oblast(a, b) || oblast(b, a)) return true;
  // An oblast's administration is not the municipality of its town, however alike the two names are.
  if (a.startsWith('ОБЛАСТ ') !== b.startsWith('ОБЛАСТ ')) return false;
  const [p, q] = [written(bare(a)), written(bare(b))];
  if (p === q) return true;
  const [x, y] = [wordsOf(p), wordsOf(q)];
  if (!x.length || !y.length) return false;
  const digits = (ws: string[]): string => ws.filter((w) => /^\d+$/.test(w)).join(' ');
  if (digits(x) !== digits(y)) return false;
  // A missing space („… УСЛУГИЕООД") or a legal form given once and left out the next time.
  const squash = (k: string): string => k.replace(/[^0-9A-ZА-Я]/gu, '').replace(LEGAL_FORM, '');
  if (x.join('') === y.join('') || squash(p) === squash(q)) return true;
  const [few, many] = x.length <= y.length ? [x, y] : [y, x];
  // One name inside the other: the same body with a place or a unit after it. Not when a filing lists several
  // bodies at once („… / …", „…; …") — each of them is inside the list, and they are not each other.
  const lists = (k: string): boolean => /[;/]/.test(k);
  if (!lists(a) && !lists(b) && few.every((w) => many.includes(w))) return true;
  if (abbreviates(x, y) || abbreviates(y, x)) return true;
  // A typing error in one long word.
  if (x.length === y.length) {
    const differing = x.flatMap((w, i) => (w === y[i] ? [] : [[w, y[i]!] as const]));
    if (differing.length === 1) {
      const [v, w] = differing[0]!;
      const shorter = Math.min(v.length, w.length);
      // Two letters in a long word, one in a shorter one; a word under five letters is too short to tell.
      return shorter >= 5 && editDistance(v, w, 2) <= (shorter >= 7 ? 2 : 1);
    }
  }
  return false;
}

interface Group {
  /** Each spelling of the institution and how many filings carry it. */
  names: Map<string, number>;
  /** The identity keys of those spellings. */
  keys: Set<string>;
  positions: Map<string, string>;
  dated: Dated[];
  seen: Set<string>;
}

/** The spellings, the one most filings use first; the longer one on a tie, so an abbreviation yields to the name. */
const namesOf = (g: Group): string[] =>
  [...g.names]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0], 'bg'))
    .map(([name]) => name);

const sharePosition = (a: Group, b: Group): boolean =>
  [...a.positions.keys()].some((p) =>
    [...b.positions.keys()].some(
      (q) => p === q || (Math.min(p.length, q.length) >= 6 && (p.includes(q) || q.includes(p))),
    ),
  );
const yearsTouch = (a: Group, b: Group): boolean =>
  a.dated.some((f) => b.dated.some((g) => Math.abs(Number(f.year) - Number(g.year)) <= 1));
const oneOffice = (a: Group, b: Group): boolean =>
  sharePosition(a, b) &&
  yearsTouch(a, b) &&
  // EVERY spelling of one with every spelling of the other: a filing that lists two bodies („X, Y") is like
  // each of them, and must not become the bridge that joins X to Y.
  [...a.keys].every((k) => [...b.keys].every((l) => sameBodySpelling(k, l)));

function join(into: Group, from: Group): void {
  for (const [name, n] of from.names) into.names.set(name, (into.names.get(name) ?? 0) + n);
  for (const key of from.keys) into.keys.add(key);
  for (const [key, position] of from.positions)
    if (!into.positions.has(key)) into.positions.set(key, position);
  for (const d of from.dated) {
    const id = `${d.year}|${d.kind}|${d.day ?? ''}`;
    if (into.seen.has(id)) continue;
    into.seen.add(id);
    into.dated.push(d);
  }
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
  const byKey = new Map<string, Group>();
  for (const f of filings) {
    const institution = f.institution?.trim();
    const key = officeKey(institution);
    if (!institution || !key) continue;
    const g = byKey.get(key) ?? {
      names: new Map<string, number>(),
      keys: new Set<string>(),
      positions: new Map<string, string>(),
      dated: [],
      seen: new Set<string>(),
    };
    byKey.set(key, g);
    g.names.set(institution, (g.names.get(institution) ?? 0) + 1);
    g.keys.add(identityInstitution(institution));
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
  // One office under two spellings joins into one, until nothing more joins.
  const groups = [...byKey.values()];
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++)
      for (let j = i + 1; j < groups.length && !merged; j++)
        if (oneOffice(groups[i]!, groups[j]!)) {
          join(groups[i]!, groups[j]!);
          groups.splice(j, 1);
          merged = true;
        }
  }
  return groups
    .map((g): PublicOffice => {
      const spellings = namesOf(g);
      const institution = spellings[0]!;
      const positions = [...g.positions.values()].sort((a, b) => a.localeCompare(b, 'bg'));
      if (!g.dated.length)
        return { institution, spellings, positions, periods: [], status: { kind: 'undated' } };
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
        institution,
        spellings,
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

/** A position as a reader meets it: a filing typed in capitals is set in sentence case, the rest stays as filed. */
function positionWords(position: string): string {
  const letters = position.replace(/[^\p{L}]/gu, '');
  return letters.length > 5 && letters === letters.toUpperCase()
    ? position.charAt(0) + position.slice(1).toLowerCase()
    : position;
}

/** „Бивш", agreeing with the position where its first word shows a gender: „бивша главна счетоводителка". */
function formerWord(position: string): string {
  const first = position.trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
  return /[^аъ]а$/u.test(first) || /ка$/u.test(first)
    ? 'Бивша'
    : /но$/u.test(first)
      ? 'Бивше'
      : 'Бивш';
}

/**
 * The position, with „Бивш" in front of it when — and only when — the office is former: „Бивш кмет",
 * „Кмет, общински съветник". An office with no position on record is „Бивша длъжност" or nothing.
 */
export function officeTitle(o: PublicOffice): string | null {
  // An abbreviation keeps its capitals („ИД директор"); an ordinary word inside the line is in lower case.
  const lowered = (p: string): string =>
    /^\p{Lu}\p{Ll}/u.test(p) ? p.charAt(0).toLowerCase() + p.slice(1) : p;
  const [first, ...rest] = o.positions.map(positionWords);
  if (!first) return o.status.kind === 'former' ? 'Бивша длъжност' : null;
  const head =
    o.status.kind === 'former'
      ? `${formerWord(first)} ${lowered(first)}`
      : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest.map(lowered)].join(', ');
}

/**
 * The years as the status allows them to be read. A former office has an end on record, so its years stand as
 * a period: „2023–2024". For any other office they are only the years somebody filed for — „декларации за
 * 2019–2023" — which says neither that the office goes on nor that it ended.
 */
export function officeYearsText(o: PublicOffice): string | null {
  const periods = officePeriodsText(o);
  if (!periods) return null;
  if (o.status.kind === 'former') return periods;
  return `${/^\d{4}$/.test(periods) ? 'декларация' : 'декларации'} за ${periods}`;
}

/** One office in one line: „Бивш кмет · Община Тестово · 2015–2019". */
export function officeLine(o: PublicOffice): string {
  return [officeTitle(o), o.institution, officeYearsText(o)].filter(Boolean).join(' · ');
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
 * A person's offices in one line, for a search hit: the latest office — „Бивш" only when the rule allows —
 * its institution and its years, then how many more offices there are.
 * „Бивш кмет · Община Тестово · 2015–2019 · още 1 длъжност".
 */
export function officesLine(offices: PublicOffice[]): string | null {
  const [o] = offices;
  if (!o) return null;
  return [
    officeLine(o),
    offices.length > 1
      ? `още ${offices.length - 1} ${offices.length === 2 ? 'длъжност' : 'длъжности'}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
