-- Every person with a page is findable by name (kind 'person'): each declarant not already indexed as an
-- office-holder with a published stake, and each person the Trade Register records in a public role at a
-- company with contracts. A declarant the register identifies is listed once, as the declarant.
-- Applied by the declarations job after publication; the registry side follows at the next run.
DELETE FROM search_index WHERE kind = 'person';

INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'person', p.id, p.name, '',
  (SELECT CASE WHEN COALESCE(d.position, '') <> '' AND COALESCE(d.institution, '') <> ''
               THEN d.position || ' · ' || d.institution
               ELSE COALESCE(NULLIF(d.position, ''), d.institution) END
   FROM declarations d WHERE d.person_id = p.id
   ORDER BY d.declared_year DESC, d.id DESC LIMIT 1),
  NULL
FROM persons p
WHERE EXISTS (SELECT 1 FROM declarations d WHERE d.person_id = p.id)
  -- Uncorrelated: the full-text table has no index on kind, so it is read once.
  AND p.id NOT IN (SELECT ref FROM search_index WHERE kind = 'official');

INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'person', rp.indent, rp.name, '',
  (SELECT group_concat(company, ', ') FROM (
     SELECT DISTINCT b.name company FROM registry_roles r
     JOIN bidders b ON b.id = 'eik:' || r.eik JOIN company_totals ct ON ct.bidder_id = b.id AND ct.contracts > 0
     WHERE r.subject_id = rp.indent AND r.subject_kind = 'person'
       AND r.role IN ('manager', 'representative', 'chair', 'board_of_directors', 'management_board',
                      'governing_body', 'board_of_trustees', 'supervisory_board', 'controlling_board',
                      'verification_commission', 'partner', 'sole_owner', 'trader', 'procurator',
                      'branch_manager', 'liquidator', 'trustee')
     ORDER BY r.removed_on IS NOT NULL, b.name LIMIT 2)),
  NULL
FROM registry_persons rp
WHERE EXISTS (
    SELECT 1 FROM registry_roles r
    JOIN bidders b ON b.id = 'eik:' || r.eik JOIN company_totals ct ON ct.bidder_id = b.id AND ct.contracts > 0
    WHERE r.subject_id = rp.indent AND r.subject_kind = 'person'
      AND r.role IN ('manager', 'representative', 'chair', 'board_of_directors', 'management_board',
                     'governing_body', 'board_of_trustees', 'supervisory_board', 'controlling_board',
                     'verification_commission', 'partner', 'sole_owner', 'trader', 'procurator',
                     'branch_manager', 'liquidator', 'trustee'))
  AND rp.indent NOT IN (
    SELECT e.registry_indent FROM person_entities e
    WHERE e.registry_indent IS NOT NULL
      AND EXISTS (SELECT 1 FROM declarations d WHERE d.person_id = e.id));
