import { companyNamesAlike } from '@sigma/shared';
import { declaredOfficeYear, officeBounds, withinOffice } from './declaration-source';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';
import { personSlug } from './identity';

// Canonical identity precedes grouping. Source person ids remain distinct unless the
// declaration-to-registry bridge proves their public Indent; names are never a join key.
// The authority's payees, read ONCE. As a correlated EXISTS inside `links` this ran per candidate link
// and D1 answered „exceeded its CPU time limit and was reset" for any authority of real size — the filter
// the institution profile links to was dead above roughly two thousand contracts.
const PAID_BY_AUTHORITY = `paid AS MATERIALIZED (
  SELECT DISTINCT b.eik_normalized eik FROM contracts c
  JOIN tenders t ON t.id=c.tender_id JOIN bidders b ON b.id=c.bidder_id
  WHERE ?1 IS NOT NULL AND t.authority_id=?1
)`;

const CTE = `WITH ${PAID_BY_AUTHORITY}, links AS MATERIALIZED (
  SELECT il.*, COALESCE(pl.registry_indent,il.person_id) identity, p.name
  FROM interest_links il JOIN persons p ON p.id=il.person_id
  LEFT JOIN person_registry_links pl ON pl.person_id=il.person_id
  WHERE ${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY}
    AND (?1 IS NULL OR il.eik IN (SELECT eik FROM paid))
), office_years AS MATERIALIZED (
  SELECT DISTINCT COALESCE(pl.registry_indent,d.person_id) identity,d.declared_year year
  FROM declarations d LEFT JOIN person_registry_links pl ON pl.person_id=d.person_id
  WHERE ${declaredOfficeYear()}
), office_bounds AS MATERIALIZED (${officeBounds('1=1')}), company_contracts AS MATERIALIZED (
  SELECT c.id, b.eik_normalized eik,c.amount_eur,c.signed_at
  FROM bidders b JOIN contracts c ON c.bidder_id=b.id JOIN tenders t ON t.id=c.tender_id
  JOIN authorities a ON a.id=t.authority_id
  WHERE b.eik_normalized IN (SELECT eik FROM links)
), person_contracts AS (
  -- BOTH, at the moment of signing: the declared interest covers the date AND the person was in office.
  SELECT l.identity,c.id,c.eik,c.amount_eur,
    MAX(oy.identity IS NOT NULL AND ${withinOffice('ob', 'c.signed_at')}
      AND strftime('%Y',c.signed_at) BETWEEN l.first_declared_year AND l.last_declared_year) in_window
  FROM links l JOIN company_contracts c ON c.eik=l.eik
  LEFT JOIN office_years oy ON oy.identity=l.identity AND oy.year=strftime('%Y',c.signed_at)
  LEFT JOIN office_bounds ob ON ob.person_id=l.person_id
  GROUP BY l.identity,c.id
), totals AS (
  SELECT identity,COUNT(*) contract_count,COUNT(DISTINCT eik) company_count,SUM(amount_eur) total_eur,
    SUM(CASE WHEN in_window THEN amount_eur END) window_eur,MAX(in_window) has_window
  FROM person_contracts GROUP BY identity
), representatives AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY identity ORDER BY (own_institution='exact') DESC,
    last_declared_year DESC,person_id,link_key) rn FROM links
), grouped_people AS (
  SELECT l.identity,MAX(l.own_institution='exact') own_institution,
    MAX(l.interest_class='private_ownership') self_stake,MAX(l.interest_class='family_ownership') family_stake
  FROM links l JOIN totals t ON t.identity=l.identity GROUP BY l.identity
)`;

export async function getRelatedPersonRows(db: D1Database, authorityId?: string) {
  const result = await db
    .prepare(
      `${CTE}
    SELECT p.*,r.name,r.person_id,t.*,
      (SELECT json_group_array(json_object('eik',co.eik,'company',co.company,'self',co.self,'family',co.family,'manages',co.manages)) FROM (
        SELECT l.eik,COALESCE(b.name,l.eik) company,MAX(l.relation IN ('owns','owns+manages')) self,
          MAX(l.interest_class='family_ownership') family,MAX(l.relation='manages') manages
        FROM links l JOIN bidders b ON b.eik_normalized=l.eik WHERE l.identity=p.identity GROUP BY l.eik ORDER BY b.name
      ) co) companies,
      (SELECT b.name FROM bidders b WHERE b.eik_normalized=r.eik ORDER BY b.id LIMIT 1) company,r.eik,
      (SELECT json_group_array(json_object('institution',d.institution,'position',d.position,'year',d.declared_year))
        FROM declarations d WHERE d.person_id IN (SELECT person_id FROM links WHERE identity=p.identity)) offices
    FROM grouped_people p JOIN representatives r ON r.identity=p.identity AND r.rn=1 JOIN totals t ON t.identity=p.identity
    ORDER BY CASE WHEN p.own_institution THEN 2 WHEN t.has_window THEN 1 ELSE 0 END DESC,
      t.total_eur DESC,p.identity`,
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
      manages: number;
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
    declaredOffices: JSON.parse(r.offices) as {
      institution: string | null;
      position: string | null;
      year: string | null;
    }[],
  }));
}

/** People with declarations whom the register records as an owner — partner, sole owner or sole trader — or
 *  on the GOVERNING BODY of a private procurement winner, and who have no published declared interest: the
 *  same row shape as the declared list, so the two read as one.
 *
 *  „Governing body" is the legal organ, not one legal form's word for it (ADR-0047 §3 decided management of a
 *  private company shows beside a stake; `manager` alone implemented only the ООД's управител). A company
 *  limited by shares is run by its съвет на директорите or управителен съвет, and its members decide whether
 *  the company bids exactly as an управител does. Oversight-only seats — надзорен, контролен, проверителна
 *  комисия — are NOT here: they appoint and check, they do not manage. Nor is a прокурист (an employee with
 *  wide powers), a управител на клон (runs a branch, not the company), a ликвидатор or a синдик.
 *
 *  A public enterprise is left out whatever the role: a seat there is a held position (ADR-0047 §2). The
 *  period figures follow the declared office years. */
export async function getRegistryRolePersonRows(db: D1Database, authorityId?: string) {
  const result = await db
    .prepare(
      `WITH ${PAID_BY_AUTHORITY}, people AS MATERIALIZED (
    SELECT pl.person_id, pl.registry_indent identity, p.name
    FROM person_registry_links pl JOIN persons p ON p.id=pl.person_id
    WHERE NOT EXISTS (SELECT 1 FROM interest_links il WHERE il.person_id=pl.person_id AND il.status='published'
        AND il.interest_class IN ('private_ownership','family_ownership'))
  ), roles AS MATERIALIZED (
    SELECT pe.person_id, pe.identity, r.eik, MAX(r.role IN ('sole_owner','partner','trader')) owner
    FROM people pe JOIN registry_roles r ON r.subject_id=pe.identity AND r.subject_kind='person'
      AND r.role IN ('sole_owner','partner','trader','manager',
                     'board_of_directors','management_board','governing_body')
    JOIN bidders b ON b.eik_normalized=r.eik AND b.ownership_kind IS NULL
    JOIN company_totals ct ON ct.bidder_id=b.id AND ct.contracts>0
    WHERE ?1 IS NULL OR r.eik IN (SELECT eik FROM paid)
    GROUP BY pe.person_id, r.eik
  ), office_years AS MATERIALIZED (
    SELECT DISTINCT d.person_id, d.declared_year year FROM declarations d
    WHERE d.person_id IN (SELECT person_id FROM roles) AND ${declaredOfficeYear()}
  ), office_bounds AS MATERIALIZED (${officeBounds('d.person_id IN (SELECT person_id FROM roles)')}
  ), company_contracts AS MATERIALIZED (
    SELECT c.id, b.eik_normalized eik, c.amount_eur, c.signed_at
    FROM bidders b JOIN contracts c ON c.bidder_id=b.id
    WHERE b.eik_normalized IN (SELECT eik FROM roles)
  ), person_contracts AS (
    -- „Стойност в периода" needs BOTH at the moment of signing: the role registered at THIS company AND
    -- a public office. Either condition alone answers a different question and answers it wrongly —
    -- a man who ran the state electricity company until March 2025 and joined a private trader's board
    -- that October had the trader's 2022-2024 contracts counted, 419 of 472 млн. € against a tie worth
    -- 64 contracts. Same predicate as during_role (person-activity.ts), so the list and the profile
    -- cannot disagree: an open role counts only up to the last successful read of the partida.
    SELECT ro.person_id, c.id, c.eik, c.amount_eur,
      MAX(oy.person_id IS NOT NULL AND ${withinOffice('ob', 'c.signed_at')} AND EXISTS (SELECT 1 FROM registry_roles rr
        WHERE rr.subject_id=ro.identity AND rr.subject_kind='person' AND rr.eik=ro.eik
          AND rr.role IN ('sole_owner','partner','trader','manager',
                          'board_of_directors','management_board','governing_body')
          AND c.signed_at IS NOT NULL AND rr.added_on<>'' AND date(c.signed_at)>=date(rr.added_on)
          AND (rr.uncertain_after IS NULL OR date(c.signed_at)<date(rr.uncertain_after))
          AND (date(c.signed_at)<date(rr.removed_on) OR (rr.removed_on IS NULL AND EXISTS (
            SELECT 1 FROM registry_deeds rd WHERE rd.eik=rr.eik AND rd.outcome='ok'
              AND date(c.signed_at)<=date(rd.fetched_at)))))) in_window
    FROM roles ro JOIN company_contracts c ON c.eik=ro.eik
    LEFT JOIN office_years oy ON oy.person_id=ro.person_id AND oy.year=strftime('%Y',c.signed_at)
    LEFT JOIN office_bounds ob ON ob.person_id=ro.person_id
    GROUP BY ro.person_id, c.id
  ), totals AS (
    SELECT person_id, COUNT(*) contract_count, COUNT(DISTINCT eik) company_count, SUM(amount_eur) total_eur,
      SUM(CASE WHEN in_window THEN amount_eur END) window_eur, MAX(in_window) has_window
    FROM person_contracts GROUP BY person_id
  )
  SELECT pe.person_id, pe.identity, pe.name, t.*,
    (SELECT json_group_array(json_object('eik',co.eik,'company',co.company,'self',0,'family',0,'registry',1,
      'registryRole',co.registry_role,'annual',json(co.annual))) FROM (
      SELECT ro.eik, COALESCE(b.name, ro.eik) company,
        CASE WHEN ro.owner THEN 'owner' ELSE 'manager' END registry_role,
        -- The annual declarations for a year the register records the ownership that do not tie to this ЕИК,
        -- with what each names; the name comparison is made below.
        (SELECT json_group_array(json_object('year',d.declared_year,'named',json((SELECT json_group_array(di.entity_raw)
          FROM declared_interests di WHERE di.declaration_id=d.id)))) FROM declarations d
          JOIN declaration_metadata m ON m.declaration_id=d.id AND lower(m.declaration_type) IN ('annualy','annual','yearly')
          WHERE d.person_id=pe.person_id AND d.declared_year IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM declaration_companies dc WHERE dc.declaration_id=d.id AND dc.eik=ro.eik)
            AND EXISTS (SELECT 1 FROM registry_roles r WHERE r.subject_id=pe.identity AND r.subject_kind='person'
              AND r.eik=ro.eik AND r.role IN ('sole_owner','partner','trader') AND r.added_on<>''
              AND date(r.added_on)<=date(d.declared_year||'-12-31')
              AND (r.removed_on IS NULL OR date(r.removed_on)>date(d.declared_year||'-12-31'))
              AND (r.uncertain_after IS NULL OR date(r.uncertain_after)>date(d.declared_year||'-12-31')))) annual
      FROM roles ro
      LEFT JOIN bidders b ON b.eik_normalized=ro.eik WHERE ro.person_id=pe.person_id GROUP BY ro.eik ORDER BY b.name
    ) co) companies,
    (SELECT json_group_array(json_object('institution',d.institution,'position',d.position,'year',d.declared_year))
      FROM declarations d WHERE d.person_id=pe.person_id) offices
  FROM people pe JOIN totals t ON t.person_id=pe.person_id
  ORDER BY t.has_window DESC, t.total_eur DESC, pe.identity`,
    )
    .bind(authorityId ?? null)
    .all<{
      person_id: string;
      identity: string;
      name: string;
      contract_count: number;
      company_count: number;
      total_eur: number | null;
      window_eur: number | null;
      has_window: number;
      companies: string;
      offices: string;
    }>();
  return result.results.map((r) => ({
    official: r.name,
    officialSlug: personSlug(r.person_id),
    personIdentity: r.identity,
    institution: null,
    position: null,
    companyCount: r.company_count,
    companies: (
      JSON.parse(r.companies) as {
        company: string;
        eik: string;
        self: number;
        family: number;
        registry: number;
        registryRole: 'owner' | 'manager';
        annual: { year: string; named: string[] }[];
      }[]
    ).map(({ annual, ...c }) => ({
      ...c,
      // A document naming the company under any spelling names it; a blank one names nothing.
      missingYears: [
        ...new Set(
          annual
            .filter((d) => !d.named.some((n) => companyNamesAlike(n, c.company)))
            .map((d) => d.year),
        ),
      ].sort(),
    })),
    soleCompany: null,
    contractCount: r.contract_count,
    contractValueEur: r.total_eur,
    contemporaneousValueEur: r.window_eur,
    stakeKind: 'registry' as const,
    ownInstitution: false,
    hasContemporaneous: !!r.has_window,
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
    SELECT c.id,c.amount_eur,MAX(oy.identity IS NOT NULL) in_window
    FROM selected l JOIN company_contracts c ON c.eik=l.eik
    LEFT JOIN office_years oy ON oy.identity=l.identity AND oy.year=strftime('%Y',c.signed_at)
    GROUP BY c.id
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
