import type { PersonDeclaration } from '@sigma/api-contract';
import { declarationMatchesLink, declarationYearDisputed } from './declaration-source';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';

/** All available source documents for a surfaced declarant, including empty filings. */
export async function getPersonDeclarations(
  db: D1Database,
  personId: string,
): Promise<PersonDeclaration[]> {
  const companyPredicate = `${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}`;
  const legacySource = `il.match_method='exact_name_key' AND EXISTS (SELECT 1 FROM declared_interests di
    WHERE di.declaration_id=d.id AND di.entity_key=il.entity_key)`;
  let metadata = true;
  let resolvedSources = true;
  let rows;
  for (;;) {
    const sql = `SELECT d.id, d.declared_year, d.template, d.category, d.institution, d.position, d.source_url,
      ${metadata ? 'm.declaration_type, m.declared_on, m.submitted_on' : 'NULL AS declaration_type, NULL AS declared_on, NULL AS submitted_on'},
      (SELECT json_group_array(DISTINCT il.eik) FROM interest_links il
        WHERE il.person_id=d.person_id AND ${companyPredicate}
          AND ${resolvedSources ? declarationMatchesLink() : legacySource}) AS companies
      FROM declarations d ${metadata ? 'LEFT JOIN declaration_metadata m ON m.declaration_id=d.id' : ''}
      WHERE d.person_id=? ORDER BY d.declared_year DESC, d.id DESC`;
    try {
      rows = await db.prepare(sql).bind(personId).all<Record<string, unknown>>();
      break;
    } catch (e) {
      if (metadata && /no such table:?\s*declaration_metadata/i.test(String(e))) metadata = false;
      else if (resolvedSources && /no such table:?\s*declaration_companies/i.test(String(e)))
        resolvedSources = false;
      else throw e;
    }
  }
  // Do not transmit the free-text detail field: only the named entity and the declared kind/time.
  const interests = await db
    .prepare(
      `SELECT di.declaration_id,di.entity_raw,di.kind,di.timing,
    (SELECT json_group_array(DISTINCT json_object('eik',il.eik,'scope',CASE WHEN il.interest_class='family_ownership' THEN 'family' ELSE 'self' END))
      FROM interest_links il WHERE il.person_id=d.person_id AND il.entity_key=di.entity_key
      AND ${companyPredicate} AND ${resolvedSources ? declarationMatchesLink() : legacySource}
      AND EXISTS (SELECT 1 FROM interest_link_observations o WHERE o.link_key=il.link_key
        AND o.declaration_id=d.id AND o.kind=di.kind AND o.timing=di.timing)) matches
    FROM declared_interests di JOIN declarations d ON d.id=di.declaration_id
    WHERE d.person_id=? ORDER BY di.entity_raw,di.kind,di.timing`,
    )
    .bind(personId)
    .all<{
      declaration_id: string;
      entity_raw: string;
      kind: string;
      timing: string;
      matches: string;
    }>();
  const comparisons = await db
    .prepare(
      `SELECT DISTINCT il.eik,b.name company,o.declaration_id,
    o.reported_year year,o.timing,CASE WHEN il.interest_class='family_ownership' THEN 'family' ELSE 'self' END scope
    FROM interest_links il JOIN bidders b ON b.id=il.bidder_id
    JOIN interest_link_observations o ON o.link_key=il.link_key
    WHERE il.person_id=? AND ${companyPredicate} AND o.kind='shares'
      AND o.timing IN ('annual','not_listed')
      AND ${metadata ? "EXISTS (SELECT 1 FROM declaration_metadata annual WHERE annual.declaration_id=o.declaration_id AND lower(annual.declaration_type) IN ('annualy','annual','yearly'))" : "o.timing='not_listed'"}
      AND ${declarationYearDisputed('il', 'o.reported_year')}`,
    )
    .bind(personId)
    .all<{
      eik: string;
      company: string;
      declaration_id: string;
      year: string;
      timing: string;
      scope: 'self' | 'family';
    }>();
  return rows.results
    .map((r) => ({
      id: String(r.id),
      year: r.declared_year as string | null,
      template: String(r.template),
      type: r.declaration_type as string | null,
      declaredOn: r.declared_on as string | null,
      submittedOn: r.submitted_on as string | null,
      institution: r.institution as string | null,
      position: r.position as string | null,
      url: String(r.source_url),
      interests: interests.results
        .filter((i) => i.declaration_id === r.id)
        .map((i) => {
          const matches = JSON.parse(i.matches) as { eik: string; scope: 'self' | 'family' }[];
          const eiks = new Set(matches.map((m) => m.eik));
          const scopes = new Set(matches.map((m) => m.scope));
          return {
            company: i.entity_raw,
            kind: i.kind,
            timing: i.timing,
            eik: eiks.size === 1 ? matches[0]!.eik : null,
            scope: scopes.size === 1 ? matches[0]!.scope : ('unknown' as const),
          };
        }),
      discrepancies: comparisons.results
        .filter((c) => c.declaration_id === r.id)
        .map((c) => ({
          eik: c.eik,
          company: c.company,
          year: c.year,
          scope: c.scope,
          listed: c.timing === 'annual',
          otherDeclarationIds: [
            ...new Set(
              comparisons.results
                .filter(
                  (other) =>
                    other.eik === c.eik &&
                    other.scope === c.scope &&
                    other.year === c.year &&
                    other.timing !== c.timing,
                )
                .map((other) => other.declaration_id),
            ),
          ],
        })),
      companyEiks: JSON.parse(String(r.companies ?? '[]')) as string[],
    }))
    .sort(
      (a, b) =>
        (b.year ?? '').localeCompare(a.year ?? '') ||
        (b.submittedOn ?? b.declaredOn ?? '').localeCompare(a.submittedOn ?? a.declaredOn ?? '') ||
        a.id.localeCompare(b.id),
    );
}
