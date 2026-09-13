import type { ConflictLink } from '@sigma/api-contract';
import { groupByPerson, type ConflictPersonRow } from './conflicts';

// Reviewed presentation groups, never a name-only match or a Trade Register identity.
// Evidence: docs/implementation-plans/company-declarant-grouping.md.
const reviewedGroups = [
  {
    id: 'kab:03387',
    slugs: [
      // Румен Стефанов Стефанов — Пазарджик; Белово.
      '0KDQo9Cc0JXQnSDQodCi0JXQpNCQ0J3QntCSINCh0KLQldCk0JDQndCe0JJ80J_QkNCX0JDQoNCU0JbQmNCa',
      '0KDQo9Cc0JXQnSDQodCi0JXQpNCQ0J3QntCSINCh0KLQldCk0JDQndCe0JJ80JHQldCb0J7QktCe',
    ],
  },
];

/** A company table can show a reviewed person once while retaining each source profile. */
export function companyDeclarantGroups(links: ConflictLink[]): ConflictPersonRow[][] {
  const reviewed = new Map<string, string>();
  for (const group of reviewedGroups) {
    const registryIds = new Set(
      links
        .filter((l) => group.slugs.includes(l.officialSlug) && l.registryPersonId)
        .map((l) => l.registryPersonId),
    );
    // New contradictory registry evidence must not be hidden by a presentation correction.
    if (registryIds.size > 1) continue;
    for (const slug of group.slugs) reviewed.set(slug, group.id);
  }
  const groups = new Map<string, ConflictPersonRow[]>();
  for (const row of groupByPerson(links)) {
    const key = reviewed.get(row.officialSlug) ?? row.personIdentity ?? row.officialSlug;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}
