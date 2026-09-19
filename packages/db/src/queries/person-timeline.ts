import { declarationYearDisputed } from './declaration-source';
import { cleanName } from '@sigma/shared';
import { personActivityScope } from './person-activity';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';

export interface InterestObservation {
  eik: string;
  declarationId: string;
  kind: string;
  timing: string;
  reportedYear: string | null;
  scope: 'self' | 'family';
  disputed?: number;
}
export interface TimelineContracts {
  eik: string;
  company: string;
  year: string | null;
  contracts: number;
  role: number;
  declared: number;
  /** Signed while BOTH held: a tie to THIS company (a registered role or a declared interest) and a
   *  public office. What the timeline marks, because it is what the surface claims. */
  tied: number;
  /** Signed in a year this person filed for SOME office. Company-agnostic, so it says nothing about a
   *  tie to this company: it marked a contractor's whole history red when the person joined its board
   *  in the last year. Kept for the contract table's own „в декларирания период" facet. */
  eligible: number;
  valueEur: number | null;
}
/** Whole-corpus year bins, independent of the contract table's pagination or card limits. */
export async function getPersonTimeline(
  db: D1Database,
  indent: string | null,
  personIds: string[],
) {
  const ids = [...new Set(personIds)];
  const { cte, params } = personActivityScope(indent, ids);
  const [contracts, observations, reads, buyers, offices, authorities] = await Promise.all([
    db
      .prepare(
        `${cte} SELECT eik,company,strftime('%Y',signed_at) year,COUNT(*) contracts,
      SUM(during_role) role,SUM(during_declaration) declared,
      SUM(during_overlap) tied,
      SUM(during_office_year) eligible,SUM(amount_eur) valueEur
      FROM activity GROUP BY eik,year ORDER BY company,year`,
      )
      .bind(...params)
      .all<TimelineContracts>(),
    db
      .prepare(
        `SELECT DISTINCT il.eik,o.declaration_id declarationId,o.kind,o.timing,o.reported_year reportedYear, (o.kind='shares' AND o.timing IN ('annual','not_listed')
        AND EXISTS (SELECT 1 FROM declaration_metadata annual WHERE annual.declaration_id=o.declaration_id AND lower(annual.declaration_type) IN ('annualy','annual','yearly'))
        AND ${declarationYearDisputed('il', 'o.reported_year')}) disputed,
      CASE WHEN il.interest_class='family_ownership' THEN 'family' ELSE 'self' END scope
      FROM interest_links il JOIN interest_link_observations o ON o.link_key=il.link_key
      WHERE il.person_id IN (SELECT value FROM json_each(?)) AND ${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}
      ORDER BY il.eik,o.reported_year,o.declaration_id,o.kind,o.timing`,
      )
      .bind(JSON.stringify(ids))
      .all<InterestObservation>(),
    db
      .prepare(
        `SELECT DISTINCT d.eik,d.fetched_at asOf FROM registry_deeds d JOIN registry_roles r ON r.eik=d.eik
      WHERE r.subject_id=? AND r.subject_kind='person' AND d.outcome='ok'`,
      )
      .bind(indent ?? '')
      .all<{ eik: string; asOf: string }>(),
    db
      .prepare(
        `${cte} SELECT eik,strftime('%Y',signed_at) year,authority_id id,authority name,
      COUNT(*) contracts,SUM(during_office_year) eligible,SUM(amount_eur) valueEur
      FROM activity GROUP BY eik,year,authority_id ORDER BY eik,year,valueEur DESC`,
      )
      .bind(...params)
      .all<{
        eik: string;
        year: string | null;
        id: string;
        name: string;
        contracts: number;
        eligible: number;
        valueEur: number | null;
      }>(),
    db
      .prepare(
        `SELECT DISTINCT institution FROM declarations WHERE person_id IN (SELECT value FROM json_each(?)) AND institution IS NOT NULL`,
      )
      .bind(JSON.stringify(ids))
      .all<{ institution: string }>(),
    db
      .prepare(
        'SELECT a.id,a.name FROM authorities a JOIN authority_totals t ON t.authority_id=a.id',
      )
      .all<{ id: string; name: string }>(),
  ]);
  // Exact organisation names only. A locality (e.g. „Несебър“) cannot identify a municipality.
  const key = (name: string) =>
    cleanName(name)
      .normalize('NFC')
      .toUpperCase()
      .replace(/[„“”"«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const institutionProfiles = offices.results.map(({ institution }) => {
    const matches = authorities.results.filter((a) => key(a.name) === key(institution));
    return { institution, authorityId: matches.length === 1 ? matches[0]!.id : null };
  });
  return {
    contracts: contracts.results,
    observations: observations.results,
    reads: reads.results,
    buyers: buyers.results,
    institutionProfiles,
  };
}
