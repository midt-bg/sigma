import { declarationWindow } from './declaration-source';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';
import { personSlug } from './identity';

// Canonical identity precedes grouping. Source person ids remain distinct unless the
// declaration-to-registry bridge proves their public Indent; names are never a join key.
const CTE = `WITH links AS MATERIALIZED (
  SELECT il.*, COALESCE(pl.registry_indent,il.person_id) identity, p.name,
    EXISTS (SELECT 1 FROM interest_link_history h WHERE h.link_key=il.link_key AND
      (h.later_declaration_year IS NOT NULL OR h.registry_role_ended_on IS NOT NULL))
      OR il.first_declared_year IS NULL AS historical
  FROM interest_links il JOIN persons p ON p.id=il.person_id
  LEFT JOIN person_registry_links pl ON pl.person_id=il.person_id
  WHERE ${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}
    AND (?1 IS NULL OR EXISTS (SELECT 1 FROM contracts c JOIN tenders t ON t.id=c.tender_id
      JOIN bidders b ON b.id=c.bidder_id WHERE b.eik_normalized=il.eik AND t.authority_id=?1))
), company_contracts AS MATERIALIZED (
  SELECT c.id, b.eik_normalized eik,c.amount_eur,c.signed_at
  FROM bidders b JOIN contracts c ON c.bidder_id=b.id JOIN tenders t ON t.id=c.tender_id
  JOIN authorities a ON a.id=t.authority_id
  WHERE b.eik_normalized IN (SELECT eik FROM links)
), person_contracts AS (
  SELECT l.identity,c.id,c.eik,c.amount_eur,
    MAX(${declarationWindow('l', 'c.signed_at')}) in_window
  FROM links l JOIN company_contracts c ON c.eik=l.eik GROUP BY l.identity,c.id
), totals AS (
  SELECT identity,COUNT(*) contract_count,COUNT(DISTINCT eik) company_count,SUM(amount_eur) total_eur,
    SUM(CASE WHEN in_window THEN amount_eur END) window_eur,MAX(in_window) has_window
  FROM person_contracts GROUP BY identity
), representatives AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY identity ORDER BY (own_institution='exact') DESC,
    last_declared_year DESC,person_id,link_key) rn FROM links
), grouped_people AS (
  SELECT l.identity,MAX(l.own_institution='exact') own_institution,MAX(l.historical) historical,
    MAX(l.interest_class='private_ownership') self_stake,MAX(l.interest_class='family_ownership') family_stake
  FROM links l JOIN totals t ON t.identity=l.identity GROUP BY l.identity
)`;

export async function getRelatedPersonRows(db: D1Database, authorityId?: string) {
  const result = await db
    .prepare(
      `${CTE}
    SELECT p.*,r.name,r.person_id,t.*,
      (SELECT json_group_array(json_object('eik',co.eik,'company',co.company,'self',co.self,'family',co.family)) FROM (
        SELECT l.eik,COALESCE(b.name,l.eik) company,MAX(l.interest_class='private_ownership') self,MAX(l.interest_class='family_ownership') family
        FROM links l JOIN bidders b ON b.eik_normalized=l.eik WHERE l.identity=p.identity GROUP BY l.eik ORDER BY b.name
      ) co) companies,
      (SELECT b.name FROM bidders b WHERE b.eik_normalized=r.eik ORDER BY b.id LIMIT 1) company,r.eik,
      (SELECT json_group_array(json_object('institution',d.institution,'position',d.position,'year',d.declared_year))
        FROM declarations d WHERE d.person_id IN (SELECT person_id FROM links WHERE identity=p.identity)) offices
    FROM grouped_people p JOIN representatives r ON r.identity=p.identity AND r.rn=1 JOIN totals t ON t.identity=p.identity
    ORDER BY p.own_institution DESC,t.has_window DESC,t.window_eur DESC,p.identity`,
    )
    .bind(authorityId ?? null)
    .all<{
      identity: string;
      name: string;
      person_id: string;
      company: string;
      eik: string;
      company_count: number;
      contract_count: number;
      total_eur: number | null;
      window_eur: number | null;
      has_window: number;
      own_institution: number;
      historical: number;
      self_stake: number;
      family_stake: number;
      offices: string;
      companies: string;
    }>();
  return result.results.map((r) => ({
    official: r.name,
    officialSlug: personSlug(r.person_id),
    personIdentity: r.identity,
    institution: null,
    position: null,
    companyCount: r.company_count,
    companies: JSON.parse(r.companies) as {
      company: string;
      eik: string;
      self: number;
      family: number;
    }[],
    soleCompany: r.company_count === 1 ? { company: r.company, eik: r.eik } : null,
    contractCount: r.contract_count,
    contractValueEur: r.total_eur,
    contemporaneousValueEur: r.window_eur,
    stakeKind: (r.self_stake && r.family_stake ? 'mixed' : r.self_stake ? 'self' : 'family') as
      | 'mixed'
      | 'self'
      | 'family',
    ownInstitution: !!r.own_institution,
    hasContemporaneous: !!r.has_window,
    hasHistoricalLinks: !!r.historical,
    declaredOffices: JSON.parse(r.offices) as {
      institution: string | null;
      position: string | null;
      year: string | null;
    }[],
  }));
}

/** Counts canonical person–company pairs. Each contract contributes once, even across people. */
export async function getRelatedPersonHeadline(
  db: D1Database,
  identities: string[],
  authorityId?: string,
) {
  const result = await db
    .prepare(
      `${CTE}, selected AS (
    SELECT l.* FROM links l JOIN json_each(?2) j ON j.value=l.identity
  ), contracts_selected AS (
    SELECT c.id,c.amount_eur,MAX(${declarationWindow('l', 'c.signed_at')}) in_window
    FROM selected l JOIN company_contracts c ON c.eik=l.eik GROUP BY c.id
  ) SELECT (SELECT COUNT(DISTINCT identity) FROM selected) officialCount,
    (SELECT COUNT(*) FROM (SELECT DISTINCT identity,eik FROM selected)) linkCount,
    COALESCE(SUM(amount_eur),0) totalEur,COALESCE(SUM(CASE WHEN in_window THEN amount_eur END),0) contemporaneousEur
    FROM contracts_selected`,
    )
    .bind(authorityId ?? null, JSON.stringify(identities))
    .first<{
      officialCount: number;
      linkCount: number;
      totalEur: number;
      contemporaneousEur: number;
    }>();
  return result!;
}
