/** A resolved source belongs to one EIK, not to every company with the same name. */
export const declarationMatchesLink = (declaration = 'd', link = 'il'): string => `(
  EXISTS (SELECT 1 FROM declaration_companies dc
    WHERE dc.declaration_id=${declaration}.id AND dc.eik=${link}.eik)
  OR (${link}.match_method='exact_name_key'
    AND NOT EXISTS (SELECT 1 FROM declaration_companies dc WHERE dc.declaration_id=${declaration}.id)
    AND EXISTS (SELECT 1 FROM declared_interests di WHERE di.declaration_id=${declaration}.id
      AND di.entity_key=${link}.entity_key))
)`;
