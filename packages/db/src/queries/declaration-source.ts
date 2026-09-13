/** A resolved source belongs to one EIK, not to every company with the same name. */
export const declarationMatchesLink = (declaration = 'd', link = 'il'): string => `(
  EXISTS (SELECT 1 FROM declaration_companies dc
    WHERE dc.declaration_id=${declaration}.id AND dc.eik=${link}.eik)
  OR (${link}.match_method='exact_name_key'
    AND NOT EXISTS (SELECT 1 FROM declaration_companies dc WHERE dc.declaration_id=${declaration}.id)
    AND EXISTS (SELECT 1 FROM declared_interests di WHERE di.declaration_id=${declaration}.id
      AND di.entity_key=${link}.entity_key))
)`;

/** A comparable omission limits timing, never the existence of a declared relationship.
 * Proven aliases share that limitation; an unrelated namesake or a different holder does not.
 * Keep the predicate in the two search-index SQL scripts in sync (covered by SQL tests).
 */
export const declarationYearDisputed = (link: string, year: string): string => `EXISTS (
  SELECT 1 FROM interest_link_observations missing
  JOIN interest_links source_link ON source_link.link_key=missing.link_key
  WHERE missing.timing='not_listed' AND missing.reported_year=${year}
    AND source_link.eik=${link}.eik AND source_link.interest_class=${link}.interest_class
    AND source_link.status='published'
    AND (source_link.person_id=${link}.person_id OR EXISTS (
      SELECT 1 FROM person_registry_links source_person JOIN person_registry_links target_person
        ON target_person.registry_indent=source_person.registry_indent
      WHERE source_person.person_id=source_link.person_id AND target_person.person_id=${link}.person_id))
)`;

export const declarationWindow = (link: string, signedAt: string): string => `(
  strftime('%Y',${signedAt}) BETWEEN ${link}.first_declared_year AND ${link}.last_declared_year
  AND NOT ${declarationYearDisputed(link, `strftime('%Y',${signedAt})`)}
)`;
