// The timeline drawn as intervals, not only as year bins.
//
// Two things the year bins cannot show. The band: the days on which a signed contract counts as
// „в съвпадение" — tied to THIS company and in office at once. And each procurement as a span, from the day
// it was announced to the day its contract was signed.
//
// The band must agree with the red numbers to the day, or the page contradicts itself. So it is built from
// the very SQL predicates the activity CTE evaluates per contract — the office years, the office bounds, the
// declaration window with its disputed years — read as sets of days instead of tested one date at a time.
// person-intervals.test.ts checks the two against each other contract by contract.
import { declarationWindow, declaredOfficeYear, officeBounds } from './declaration-source';
import { personActivityScope } from './person-activity';
import { publicRole } from './registry';
import { NOT_REDUNDANT_FAMILY, SURFACED_OWNERSHIP } from './related-persons';

/** Inclusive day span, `YYYY-MM-DD`. */
export type DaySpan = [from: string, to: string];

export interface TimelineProcurement {
  id: string;
  eik: string;
  subject: string | null;
  authority: string;
  /** The day the procurement was announced; null when unknown or later than the signing. */
  announcedAt: string | null;
  signedAt: string;
  valueEur: number | null;
  /** Offers received, as the source reports them; null when it does not. */
  bids: number | null;
  /** The red-number test, as the activity CTE evaluates it. */
  tied: boolean;
}

export interface TimelineIntervals {
  /** Per company ЕИК: the days a signed contract counts as „в съвпадение". */
  bands: Record<string, DaySpan[]>;
  /** The years a published declared interest ties the person to a company, per scope. */
  declared: { eik: string; scope: 'self' | 'family' | 'management'; year: string }[];
  procurements: TimelineProcurement[];
}

interface RoleRow {
  eik: string;
  addedOn: string | null;
  removedOn: string | null;
  removedSet: number;
  uncertainAfter: string | null;
  observedOn: string | null;
}

type Span = [number, number];
const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
const toIso = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);
const yearSpan = (year: string | number): Span => [toDay(`${year}-01-01`), toDay(`${year}-12-31`)];

function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function intersect(x: Span[], y: Span[]): Span[] {
  const out: Span[] = [];
  let i = 0,
    j = 0;
  while (i < x.length && j < y.length) {
    const a = Math.max(x[i]![0], y[j]![0]),
      b = Math.min(x[i]![1], y[j]![1]);
    if (a <= b) out.push([a, b]);
    if (x[i]![1] < y[j]![1]) i++;
    else j++;
  }
  return out;
}

/**
 * The days a registered role supports a contract, exactly as the activity CTE tests it:
 * signed on or after `added_on`, before `removed_on` — or, while the role stands, no later than the last
 * successful read of the partida — and before `uncertain_after`.
 */
function roleSpan(r: RoleRow): Span | null {
  if (!r.addedOn) return null;
  let end: number;
  if (r.removedSet) {
    if (!r.removedOn) return null;
    end = toDay(r.removedOn) - 1;
  } else {
    if (!r.observedOn) return null;
    end = toDay(r.observedOn);
  }
  if (r.uncertainAfter) end = Math.min(end, toDay(r.uncertainAfter) - 1);
  const start = toDay(r.addedOn);
  return start <= end ? [start, end] : null;
}

/** Pure: the band per company from the primitives the SQL reads. Exported for the consistency test. */
export function overlapBands(input: {
  officeYears: string[];
  bounds: { opened: string; closed: string }[];
  roles: RoleRow[];
  declared: { eik: string; year: string }[];
}): Record<string, DaySpan[]> {
  const office = intersect(
    union(input.bounds.map((b) => [toDay(b.opened), toDay(b.closed)] as Span)),
    union(input.officeYears.map(yearSpan)),
  );
  const tie = new Map<string, Span[]>();
  const add = (eik: string, s: Span | null) => {
    if (s) tie.set(eik, [...(tie.get(eik) ?? []), s]);
  };
  for (const r of input.roles) add(r.eik, roleSpan(r));
  for (const d of input.declared) add(d.eik, yearSpan(d.year));
  const bands: Record<string, DaySpan[]> = {};
  for (const [eik, spans] of tie) {
    const band = intersect(union(spans), office);
    if (band.length) bands[eik] = band.map(([a, b]) => [toIso(a), toIso(b)]);
  }
  return bands;
}

/** Everything the interval timeline draws for one person, bounded by that person's own rows. */
export async function getTimelineIntervals(
  db: D1Database,
  indent: string | null,
  personIds: string[],
): Promise<TimelineIntervals> {
  const ids = [...new Set(personIds)];
  const { cte, params } = personActivityScope(indent, ids);
  const idsJson = JSON.stringify(ids);
  const gate = `${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY} AND il.person_id IN (SELECT value FROM json_each(?1))`;
  const [procurements, officeYears, bounds, roles, declared] = await Promise.all([
    db
      .prepare(
        `${cte} SELECT a.id, a.eik, a.subject, a.authority,
          CASE WHEN date(t.published_at) <= date(a.signed_at) THEN date(t.published_at) END AS announcedAt,
          date(a.signed_at) AS signedAt, a.amount_eur AS valueEur, c.bids_received AS bids,
          a.during_overlap AS tied
        FROM activity a JOIN contracts c ON c.id = a.id JOIN tenders t ON t.id = c.tender_id
        WHERE date(a.signed_at) IS NOT NULL
        ORDER BY a.eik, COALESCE(date(t.published_at), date(a.signed_at)), date(a.signed_at), a.id`,
      )
      .bind(...params)
      .all<Omit<TimelineProcurement, 'tied'> & { tied: number }>(),
    db
      .prepare(
        `SELECT DISTINCT d.declared_year AS year FROM declarations d
        WHERE d.person_id IN (SELECT value FROM json_each(?1)) AND ${declaredOfficeYear()}`,
      )
      .bind(idsJson)
      .all<{ year: string }>(),
    db
      .prepare(officeBounds('d.person_id IN (SELECT value FROM json_each(?1))'))
      .bind(idsJson)
      .all<{ opened: string; closed: string }>(),
    db
      .prepare(
        `SELECT r.eik, date(r.added_on) AS addedOn, date(r.removed_on) AS removedOn,
          r.removed_on IS NOT NULL AS removedSet, date(r.uncertain_after) AS uncertainAfter,
          (SELECT MAX(date(rd.fetched_at)) FROM registry_deeds rd WHERE rd.eik = r.eik AND rd.outcome = 'ok')
            AS observedOn
        FROM registry_roles r
        WHERE r.subject_id = ?1 AND r.subject_kind = 'person' AND ${publicRole('r')} AND r.added_on <> ''`,
      )
      .bind(indent ?? '')
      .all<RoleRow>(),
    db
      .prepare(
        // The declaration window depends on the year alone, so it is asked of one day per candidate year.
        `WITH RECURSIVE y(year) AS (SELECT 1990 UNION ALL SELECT year + 1 FROM y WHERE year < 2100)
        SELECT DISTINCT il.eik,
          CASE WHEN il.interest_class = 'family_ownership' THEN 'family'
               WHEN il.relation = 'manages' THEN 'management' ELSE 'self' END AS scope,
          CAST(y.year AS TEXT) AS year
        FROM interest_links il JOIN y
          ON CAST(y.year AS TEXT) BETWEEN il.first_declared_year AND il.last_declared_year
        WHERE ${gate} AND ${declarationWindow('il', "(y.year || '-07-01')")}
        ORDER BY il.eik, scope, year`,
      )
      .bind(idsJson)
      .all<TimelineIntervals['declared'][number]>(),
  ]);
  return {
    bands: overlapBands({
      officeYears: officeYears.results.map((r) => r.year),
      bounds: bounds.results,
      roles: roles.results,
      declared: declared.results,
    }),
    declared: declared.results,
    procurements: procurements.results.map((r) => ({ ...r, tied: !!r.tied })),
  };
}
