import type { PersonDeclaration } from '@sigma/api-contract';
import { declarationMatchesLink } from './declaration-source';
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
      companyEiks: JSON.parse(String(r.companies ?? '[]')) as string[],
    }))
    .sort(
      (a, b) =>
        (b.year ?? '').localeCompare(a.year ?? '') ||
        (b.submittedOn ?? b.declaredOn ?? '').localeCompare(a.submittedOn ?? a.declaredOn ?? '') ||
        a.id.localeCompare(b.id),
    );
}
