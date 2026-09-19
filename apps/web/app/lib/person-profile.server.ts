import {
  getPersonName,
  getPersonNamedBy,
  getPersonRelatives,
  getPersonSourceNames,
  getOfficialConflicts,
  getPersonTimeline,
  getPersonDeclarations,
  getPersonActivity,
  getPersonScope,
  getRegistryPerson,
} from '@sigma/db';
import { layoutTies } from './tie-layout.server';
import type { PersonDeclaration } from '@sigma/api-contract';
import { personNameKey } from '@sigma/shared';

export async function loadPersonProfile(
  db: D1Database,
  { indent, officialId, search }: { indent?: string; officialId?: string; search: URLSearchParams },
) {
  const scope = await getPersonScope(db, { indent, officialId });
  indent = scope.indent ?? undefined;
  const person = indent ? await getRegistryPerson(db, indent) : null;
  const { officialIds } = scope;
  const cases = (
    await Promise.all(officialIds.map((id) => getOfficialConflicts(db, id, { contracts: false })))
  ).filter((x) => x != null);
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
  // A declarant is a public office-holder by the same act that makes a registered person public, so
  // their own filings are enough for a profile: the offices they declared, when, and the timeline of
  // them. Before, a person with neither a Trade Register entry nor a published company link fell to a
  // bare list of documents — 34,086 of the 34,947 people on the site, or 97.5% of them.
  if (!person && !cases.length && !declarations.length) return null;
  const activity = await getPersonActivity(db, indent ?? null, officialIds, search, 'all');
  // The company facet includes the full eligible set, even when filters match no contracts.
  const companyEiks = new Set(activity.companies.map((c) => c.eik));
  const timeline = await getPersonTimeline(db, indent ?? null, officialIds);
  const declaredActivity = officialIds.length
    ? await getPersonActivity(db, indent ?? null, officialIds, new URLSearchParams(), 'declaration')
    : null;
  const name =
    person?.name ??
    cases[0]?.official ??
    (officialIds.length ? ((await getPersonName(db, officialIds[0]!)) ?? '') : '');
  // Declarations of one person filed under a changed or differently written name.
  const aliases = (await getPersonSourceNames(db, officialIds)).filter(
    (n) => personNameKey(n) !== personNameKey(name),
  );
  const [relatives, namedBy] = await Promise.all([
    getPersonRelatives(db, officialIds),
    indent ? getPersonNamedBy(db, indent) : Promise.resolve([]),
  ]);
  return {
    person,
    name,
    aliases,
    relatives,
    namedBy,
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
