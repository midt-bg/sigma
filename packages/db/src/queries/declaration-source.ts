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

/** An observed office year, never an inferred mandate or a filled gap between filings. */
export const declaredOfficeYear = (declaration = 'd'): string => `(
  NULLIF(TRIM(${declaration}.institution),'') IS NOT NULL
  AND NULLIF(TRIM(${declaration}.position),'') IS NOT NULL
  AND ${declaration}.declared_year GLOB '[0-9][0-9][0-9][0-9]'
)`;

export const declarationWindow = (link: string, signedAt: string): string => `(
  strftime('%Y',${signedAt}) BETWEEN ${link}.first_declared_year AND ${link}.last_declared_year
  AND NOT ${declarationYearDisputed(link, `strftime('%Y',${signedAt})`)}
)`;

/**
 * Per-person office bounds: the first day the register can show them in office and the last.
 *
 * The office itself is known by YEAR — a declaration naming an institution and a position is evidence
 * for its year and nothing finer. The END is known by day: somebody who left a public post in March is
 * not in office in October of the same year, yet the year says they are.
 *
 * The START is NOT taken from the entry declaration, and that asymmetry is the whole point. A filing
 * date is always LATER than the event it reports — the law gives a month to file after taking office,
 * and an exit is likewise filed afterwards. For the END a late bound is harmless: it only widens the
 * window, so no real overlap is ever cut. For the START the same lag CUTS the first weeks of office —
 * a board member appointed on the 27th, whose company signed on the 28th, filed on the 17th of the next
 * month, and the contract fell outside an office he already held. So the office opens with its first
 * year and closes on the day of the exit filing.
 *
 * An exit closes the office only when nothing later reopens it — a later entry, or a filing for a year
 * at or after the exit's own.
 *
 * ponytail: one span per person, so a gap BETWEEN two offices is not cut out; the office-year condition
 * still drops whole years with no filing. Split per institution only if a gap inside one year matters.
 */
export const officeBounds = (personFilter: string): string => `
  SELECT d.person_id,
    MIN(d.declared_year)||'-01-01' opened,
    CASE WHEN MAX(CASE WHEN lower(m.declaration_type)='vacate' AND COALESCE(m.declared_on,'')<>''
                       THEN date(m.declared_on) END)
              > COALESCE(MAX(CASE WHEN lower(m.declaration_type)='entry' AND COALESCE(m.declared_on,'')<>''
                                  THEN date(m.declared_on) END),'')
          AND strftime('%Y', MAX(CASE WHEN lower(m.declaration_type)='vacate'
                                      AND COALESCE(m.declared_on,'')<>'' THEN date(m.declared_on) END))
              >= MAX(d.declared_year)
         THEN MAX(CASE WHEN lower(m.declaration_type)='vacate' AND COALESCE(m.declared_on,'')<>''
                       THEN date(m.declared_on) END)
         ELSE MAX(d.declared_year)||'-12-31' END closed
  FROM declarations d LEFT JOIN declaration_metadata m ON m.declaration_id=d.id
  WHERE ${personFilter} AND ${declaredOfficeYear()}
  GROUP BY d.person_id`;

/** The signing date falls inside the office: the year has a filing AND the day is within the bounds. */
export const withinOffice = (bounds: string, signedAt: string): string =>
  `(${signedAt} IS NOT NULL AND date(${signedAt})>=${bounds}.opened AND date(${signedAt})<=${bounds}.closed)`;
