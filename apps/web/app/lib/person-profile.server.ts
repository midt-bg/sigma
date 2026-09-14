import {
  getOfficialConflicts,
  getPersonTimeline,
  getPersonDeclarations,
  getPersonActivity,
  getRegistryOfficials,
  getRegistryPerson,
} from '@sigma/db';
import { layoutTies } from './tie-layout.server';
import type { PersonDeclaration } from '@sigma/api-contract';

export async function loadPersonProfile(
  db: D1Database,
  { indent, officialId, search }: { indent?: string; officialId?: string; search: URLSearchParams },
) {
  const person = indent ? await getRegistryPerson(db, indent) : null;
  const officialIds = officialId
    ? [officialId]
    : indent
      ? await getRegistryOfficials(db, indent)
      : [];
  const cases = (
    await Promise.all(officialIds.map((id) => getOfficialConflicts(db, id, { contracts: false })))
  ).filter((x) => x != null);
  if (!person && !cases.length) return null;
  const links = cases.flatMap((c) => c.links);

  const declarations = [
    ...new Map(
      (await Promise.all(officialIds.map((id) => getPersonDeclarations(db, id))))
        .flat()
        .map((d) => [d.id, d]),
    ).values(),
  ].sort(
    (a, b) =>
      (b.year ?? '').localeCompare(a.year ?? '') ||
      (b.submittedOn ?? b.declaredOn ?? '').localeCompare(a.submittedOn ?? a.declaredOn ?? '') ||
      a.id.localeCompare(b.id),
  );
  const activity = await getPersonActivity(db, indent ?? null, officialIds, search, 'all');
  // The company facet includes the full eligible set, even when filters match no contracts.
  const companyEiks = new Set(activity.companies.map((c) => c.eik));
  const timeline = await getPersonTimeline(db, indent ?? null, officialIds);
  const declaredActivity = officialIds.length
    ? await getPersonActivity(db, indent ?? null, officialIds, new URLSearchParams(), 'declaration')
    : null;
  return {
    person,
    name: person?.name ?? cases[0]!.official,
    links: links.filter((l) => companyEiks.has(l.eik)),
    timeline: {
      ...timeline,
      observations: timeline.observations.filter((o) => companyEiks.has(o.eik)),
    },
    declarations: declarations.map(
      (d): PersonDeclaration => ({
        ...d,
        companyEiks: d.companyEiks.filter((eik) => companyEiks.has(eik)),
        interests: d.interests?.filter((i) => i.eik !== null && companyEiks.has(i.eik)),
        discrepancies: d.discrepancies?.filter((c) => companyEiks.has(c.eik)),
      }),
    ),
    activity,
    totals: {
      companies: activity.companyCount,
      contracts: activity.total,
      valueEur: activity.valueEur,
      declaredCount: declaredActivity?.total ?? 0,
      declaredEur: declaredActivity?.valueEur ?? null,
    },
    tieLayout: person ? layoutTies(person.network) : null,
  };
}
export type LoadedPersonProfile = NonNullable<Awaited<ReturnType<typeof loadPersonProfile>>>;
