import type { LoadedPersonProfile } from './person-profile.server';
import type { InterestObservation, TimelineContracts } from '@sigma/db';
import type { PersonRole, ConflictLink, PersonDeclaration } from '@sigma/api-contract';

export interface TimelineCompany {
  eik: string;
  name: string;
  href: string | null;
  roles: PersonRole[];
  links: ConflictLink[];
  observations: InterestObservation[];
  contracts: TimelineContracts[];
  declarations: PersonDeclaration[];
  asOf: string | null;
  /** A public enterprise: a role there is a held position, shown with the offices (ADR-0047). */
  publicEnterprise: boolean;
}
export function timelineCompanies(p: LoadedPersonProfile): TimelineCompany[] {
  const companies = new Map<string, TimelineCompany>();
  const get = (eik: string, name: string, href: string | null) => {
    if (!companies.has(eik))
      companies.set(eik, {
        eik,
        name,
        href,
        roles: [],
        links: [],
        observations: [],
        contracts: [],
        declarations: [],
        asOf: null,
        publicEnterprise: false,
      });
    return companies.get(eik)!;
  };
  for (const link of p.links)
    get(link.eik, link.company, `/companies/${link.eik}`).links.push(link);
  for (const role of p.person?.roles ?? [])
    get(role.company.eik, role.company.name, role.company.href).roles.push(role);
  for (const contracts of p.timeline.contracts)
    get(contracts.eik, contracts.company, `/companies/${contracts.eik}`).contracts.push(contracts);
  for (const c of companies.values()) {
    c.observations = p.timeline.observations.filter((o) => o.eik === c.eik);
    c.declarations = p.declarations.filter((d) => d.companyEiks.includes(c.eik));
    c.asOf = p.timeline.reads.find((r) => r.eik === c.eik)?.asOf ?? null;
    c.publicEnterprise = c.roles.some((r) => !!r.company.ownershipKind) && !c.links.length;
    c.roles = [
      ...new Map(c.roles.map((r) => [`${r.role}|${r.addedOn}|${r.removedOn}`, r])).values(),
    ];
  }
  return [...companies.values()].sort(
    (a, b) =>
      Number(b.publicEnterprise) - Number(a.publicEnterprise) ||
      Number(!!b.links.length) - Number(!!a.links.length) ||
      b.contracts.reduce((s, c) => s + c.eligible, 0) -
        a.contracts.reduce((s, c) => s + c.eligible, 0) ||
      a.name.localeCompare(b.name, 'bg'),
  );
}
export const positiveObservation = (o: Pick<InterestObservation, 'timing'>) =>
  ['annual', 'current'].includes(o.timing);

// ---- Experiment `?timeline=c`: the timeline as intervals -----------------------------------------------

/**
 * One run of consecutive office years at one institution, as its declarations show it.
 *
 * The years are what a declaration proves; the exact days are not. So the span covers whole years, and
 * says where inside them the edges are known: the start by an entry declaration (filed within a month of
 * taking office), the end by an exit declaration. An edge without one is drawn faded over its year.
 */
export interface OfficeSpan {
  from: string;
  to: string;
  /** The entry filing inside the first year: the office began no later than this. */
  knownStart: string | null;
  /** The exit filing inside the last year: the office had ended by this. */
  knownEnd: string | null;
}

const isType = (d: PersonDeclaration, type: string) => (d.type ?? '').toLowerCase() === type;

export function officeSpans(docs: PersonDeclaration[]): OfficeSpan[] {
  // The same office years the red numbers use: a year, an institution and a position.
  const years = [
    ...new Set(
      docs
        .filter((d) => d.institution?.trim() && d.position?.trim() && /^\d{4}$/.test(d.year ?? ''))
        .map((d) => +d.year!),
    ),
  ].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const y of years) {
    const run = runs.at(-1);
    if (run && run.at(-1) === y - 1) run.push(y);
    else runs.push([y]);
  }
  return runs.map((run) => {
    const first = run[0]!,
      last = run.at(-1)!;
    const inYear = (year: number, type: string) =>
      docs
        .filter((d) => isType(d, type) && d.year === String(year) && d.declaredOn)
        .map((d) => d.declaredOn!.slice(0, 10))
        .filter((day) => day.startsWith(String(year)))
        .sort();
    const knownStart = inYear(first, 'entry')[0] ?? null;
    const knownEnd = inYear(last, 'vacate').at(-1) ?? null;
    return { from: `${first}-01-01`, to: knownEnd ?? `${last}-12-31`, knownStart, knownEnd };
  });
}

/**
 * Procurements stacked into as few rows as they fit, earliest first: a row takes the next span that starts
 * after its last one ends, with room for the signing mark between them.
 */
export function packLanes<T extends { announcedAt: string | null; signedAt: string }>(
  items: T[],
  gapDays = 20,
): T[][] {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
  const lanes: { end: number; items: T[] }[] = [];
  for (const item of [...items].sort(
    (a, b) =>
      (a.announcedAt ?? a.signedAt).localeCompare(b.announcedAt ?? b.signedAt) ||
      a.signedAt.localeCompare(b.signedAt),
  )) {
    const start = day(item.announcedAt ?? item.signedAt);
    const lane = lanes.find((l) => l.end + gapDays < start);
    if (lane) {
      lane.items.push(item);
      lane.end = day(item.signedAt);
    } else lanes.push({ end: day(item.signedAt), items: [item] });
  }
  return lanes.map((l) => l.items);
}

/** Inside one of the inclusive day spans. */
export const insideSpans = (spans: [string, string][] | undefined, day: string | null) =>
  !!day && (spans ?? []).some(([a, b]) => a <= day && day <= b);

/** Consecutive years as inclusive day spans: `['2019','2020','2022']` → 2019–2020 and 2022. */
export function yearSpans(years: string[]): [string, string][] {
  const sorted = [...new Set(years)].map(Number).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const y of sorted) {
    const last = out.at(-1);
    if (last && last[1] === y - 1) last[1] = y;
    else out.push([y, y]);
  }
  return out.map(([a, b]) => [`${a}-01-01`, `${b}-12-31`]);
}
export function timelineYears(p: LoadedPersonProfile, companies: TimelineCompany[]) {
  const years = [
    ...p.declarations.map((d) => d.year),
    ...companies.flatMap((c) => [
      ...c.contracts.map((r) => r.year),
      ...c.observations.map((o) => o.reportedYear),
      ...c.roles.flatMap((r) => [r.addedOn?.slice(0, 4), (r.removedOn ?? c.asOf)?.slice(0, 4)]),
    ]),
    // Experiment: a procurement announced before the first year still starts on the axis.
    ...(p.timelineIntervals?.procurements ?? []).map((r) => r.announcedAt?.slice(0, 4)),
  ]
    .filter((y): y is string => !!y && /^\d{4}$/.test(y) && +y >= 1900 && +y <= 2200)
    .map(Number);
  if (!years.length) return [];
  const min = Math.min(...years),
    max = Math.max(...years);
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}
