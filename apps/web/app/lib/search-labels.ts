// What a search hit is called in the result gutter (ADR-0039 names the registry roles themselves).
import type { SearchHit } from '@sigma/api-contract';

export const KIND_LABEL: Record<SearchHit['kind'], string> = {
  // The hit IS the office-holder — a длъжностно лице. „свързано лице" (related person) means the RELATIVE,
  // never the official themselves; mislabeling the official that way is a category error (todorkolev #226 — C14).
  official: 'длъжностно лице',
  person: 'лице',
  authority: 'институция',
  company: 'компания',
  contract: 'договор',
};

// A registry person's route segment is the 64-hex indent the Trade Register issues; a declarant's is
// base64url of their declaration-derived id (hrefForEntity, packages/db/src/queries/identity.ts).
const REGISTRY_SEGMENT = /^[0-9a-f]{64}$/;

/** The gutter label for one hit.
 *
 * „лице" is NOT a different sort of person from „длъжностно лице" — the two people groups are split by
 * the EVIDENCE we publish (a свързани-лица link or none), not by what office anyone holds. Labelling the
 * whole second group „лице" therefore denied the office of people whose own subtitle read „главен
 * секретар · Агенция по заетостта". Everyone in the index because they FILED a declaration is an office
 * holder by construction (чл. 75 ЗСП), in either group; only the people we know solely from the Trade
 * Register are plain лица. */
export function kindLabel(hit: SearchHit): string {
  if (hit.kind !== 'person') return KIND_LABEL[hit.kind];
  const segment = hit.href.slice(hit.href.lastIndexOf('/') + 1);
  return REGISTRY_SEGMENT.test(segment) ? 'лице' : 'длъжностно лице';
}
