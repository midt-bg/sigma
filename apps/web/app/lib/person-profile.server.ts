import {
  getOfficialConflicts,
  getPersonDeclarations,
  getPersonActivity,
  getRegistryOfficials,
  getRegistryPerson,
} from '@sigma/db';
import { layoutTies } from './tie-layout.server';

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
  const cases = (await Promise.all(officialIds.map((id) => getOfficialConflicts(db, id)))).filter(
    (x) => x != null,
  );
  if (!person && !cases.length) return null;
  const links = cases.flatMap((c) => c.links);
  const contracts = Object.assign({}, ...cases.map((c) => c.contracts));
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
  const activity = await getPersonActivity(
    db,
    indent ?? null,
    officialIds,
    search,
    officialIds.length ? 'all' : 'role',
  );
  const allActivity =
    search.size || officialIds.length
      ? await getPersonActivity(db, indent ?? null, officialIds, new URLSearchParams())
      : activity;
  const declaredActivity = officialIds.length
    ? await getPersonActivity(db, indent ?? null, officialIds, new URLSearchParams(), 'declaration')
    : null;
  return {
    person,
    name: person?.name ?? cases[0]!.official,
    links,
    contracts,
    declarations,
    activity,
    totals: {
      companies: allActivity.companyCount,
      contracts: allActivity.total,
      valueEur: allActivity.valueEur,
      declaredCount: declaredActivity?.total ?? 0,
      declaredEur: declaredActivity?.valueEur ?? null,
    },
    tieLayout: person ? layoutTies(person.network) : null,
  };
}
export type LoadedPersonProfile = NonNullable<Awaited<ReturnType<typeof loadPersonProfile>>>;
