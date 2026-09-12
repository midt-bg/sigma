import { personActivityScope } from './person-activity';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';

export interface InterestObservation {
  eik: string;
  declarationId: string;
  kind: string;
  timing: string;
  reportedYear: string | null;
  scope: 'self' | 'family';
}
export interface TimelineContracts {
  eik: string;
  company: string;
  year: string | null;
  contracts: number;
  role: number;
  declared: number;
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
  const [contracts, observations, reads] = await Promise.all([
    db
      .prepare(
        `${cte} SELECT eik,company,strftime('%Y',signed_at) year,COUNT(*) contracts,
      SUM(during_role) role,SUM(during_declaration) declared,
      SUM(during_role OR during_declaration) eligible,SUM(amount_eur) valueEur
      FROM activity GROUP BY eik,year ORDER BY company,year`,
      )
      .bind(...params)
      .all<TimelineContracts>(),
    db
      .prepare(
        `SELECT DISTINCT il.eik,o.declaration_id declarationId,o.kind,o.timing,o.reported_year reportedYear,
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
  ]);
  return { contracts: contracts.results, observations: observations.results, reads: reads.results };
}
