import { publicRole } from './registry';
import { SURFACED_OWNERSHIP, NOT_REDUNDANT_FAMILY } from './related-persons';

export interface PersonContractRow {
  id: string;
  subject: string;
  company: string;
  eik: string;
  authority: string;
  authorityId: string;
  signedAt: string | null;
  valueEur: number | null;
  duringRole: boolean;
  duringDeclaration: boolean;
  declarationBasis: number; // 1 = own stake, 2 = related person's stake, 3 = both
}
export interface PersonActivity {
  contracts: PersonContractRow[];
  page: number;
  pageSize: number;
  total: number;
  companyCount: number;
  valueEur: number | null;
  roleCount: number;
  roleEur: number | null;
  declaredCount: number;
  declaredEur: number | null;
  companies: { eik: string; name: string }[];
  authorities: { id: string; name: string }[];
  yearOptions: string[];
  years: { year: string; contracts: number; valueEur: number | null }[];
  byAuthority: { id: string; name: string; contracts: number; valueEur: number | null }[];
  filters: { company: string; authority: string; year: string; basis: string };
}
export async function getRegistryIdentity(
  db: D1Database,
  personId: string,
): Promise<string | null> {
  try {
    return (
      (
        await db
          .prepare('SELECT registry_indent FROM person_registry_links WHERE person_id=?')
          .bind(personId)
          .first<{ registry_indent: string }>()
      )?.registry_indent ?? null
    );
  } catch (e) {
    if (/no such table:?\s*person_registry_links/i.test(String(e))) return null;
    throw e;
  }
}
export async function getRegistryOfficials(db: D1Database, indent: string): Promise<string[]> {
  try {
    const r = await db
      .prepare(
        `SELECT pl.person_id FROM person_registry_links pl WHERE pl.registry_indent=? AND EXISTS (
        SELECT 1 FROM person_registry_links sibling JOIN interest_links il ON il.person_id=sibling.person_id
        WHERE sibling.registry_indent=pl.registry_indent AND ${SURFACED_OWNERSHIP}
      ) ORDER BY pl.person_id`,
      )
      .bind(indent)
      .all<{ person_id: string }>();
    return r.results.map((r) => r.person_id);
  } catch (e) {
    if (/no such table:?\s*person_registry_links/i.test(String(e))) return [];
    throw e;
  }
}

export function personActivityScope(indent: string | null, ids: string[]) {
  const params: (string | number)[] = [indent ?? '', ...ids];
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(',') || "''";
  const gate = `${SURFACED_OWNERSHIP} AND ${NOT_REDUNDANT_FAMILY} AND il.person_id IN (${placeholders})`;
  const cte = `WITH scoped AS (
    SELECT DISTINCT r.eik FROM registry_roles r WHERE r.subject_id=?1 AND r.subject_kind='person' AND ${publicRole('r')}
    UNION SELECT il.eik FROM interest_links il WHERE ${gate}
  ), activity AS (
    SELECT c.id, COALESCE(c.contract_subject, t.title) AS subject, b.name AS company, b.eik_normalized AS eik, a.id AS authority_id, a.name AS authority,
      c.signed_at, c.amount_eur,
      EXISTS (SELECT 1 FROM registry_roles r WHERE r.subject_id=?1 AND r.subject_kind='person'
        AND r.eik=b.eik_normalized AND ${publicRole('r')} AND c.signed_at IS NOT NULL
        AND r.added_on<>'' AND date(c.signed_at)>=date(r.added_on)
        AND (date(c.signed_at)<date(r.removed_on) OR (r.removed_on IS NULL AND EXISTS (
          SELECT 1 FROM registry_deeds rd WHERE rd.eik=r.eik AND rd.outcome='ok'
            AND date(c.signed_at)<=date(rd.fetched_at))))) AS during_role,
      EXISTS (SELECT 1 FROM interest_links il WHERE ${gate} AND il.eik=b.eik_normalized
        AND c.signed_at IS NOT NULL AND strftime('%Y', c.signed_at) BETWEEN il.first_declared_year AND il.last_declared_year) AS during_declaration,
      (SELECT COALESCE(SUM(DISTINCT CASE WHEN il.interest_class='private_ownership' THEN 1 ELSE 2 END),0)
        FROM interest_links il WHERE ${gate} AND il.eik=b.eik_normalized AND c.signed_at IS NOT NULL
        AND strftime('%Y', c.signed_at) BETWEEN il.first_declared_year AND il.last_declared_year) AS declaration_basis
    FROM contracts c JOIN bidders b ON b.id=c.bidder_id JOIN tenders t ON t.id=c.tender_id
    JOIN authorities a ON a.id=t.authority_id JOIN scoped s ON s.eik=b.eik_normalized
  )`;
  return { cte, params };
}

/** One contract once, with independent role/declaration flags. Totals never depend on pagination. */
export async function getPersonActivity(
  db: D1Database,
  indent: string | null,
  personIds: string[],
  search: URLSearchParams,
  basis: 'role' | 'declaration' | 'self' | 'family' | 'all' | 'matched' | 'context' = 'all',
): Promise<PersonActivity> {
  const ids = [...new Set(personIds)];
  const requestedBasis = search.get('basis');
  if (
    [
      'role',
      'all',
      'matched',
      'context',
      ...(ids.length ? ['declaration', 'self', 'family'] : []),
    ].includes(requestedBasis ?? '')
  )
    basis = requestedBasis as typeof basis;
  const { cte, params } = personActivityScope(indent, ids);
  const filters = {
    company: /^\d{9}(?:\d{4})?$/.test(search.get('company') ?? '') ? search.get('company')! : '',
    authority: (search.get('authority') ?? '').slice(0, 100),
    year: /^\d{4}$/.test(search.get('year') ?? '') ? search.get('year')! : '',
    basis,
  };
  const eligibility = {
    role: 'during_role=1',
    declaration: 'during_declaration=1',
    self: '(declaration_basis & 1)<>0',
    family: '(declaration_basis & 2)<>0',
    all: '1=1',
    matched: '(during_role=1 OR during_declaration=1)',
    context: '(during_role=0 AND during_declaration=0)',
  }[basis];
  const optionEligibility = '1=1';
  const conditions: string[] = [eligibility];
  if (filters.company) {
    params.push(filters.company);
    conditions.push(`eik=?${params.length}`);
  }
  if (filters.authority) {
    params.push(filters.authority);
    conditions.push(`authority_id=?${params.length}`);
  }
  if (filters.year) {
    params.push(filters.year);
    conditions.push(`strftime('%Y',signed_at)=?${params.length}`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const query = <T>(sql: string, values = params) =>
    db
      .prepare(`${cte} ${sql}`)
      .bind(...values)
      .all<T>();
  const [totals, companies, authorities, years, byAuthority, yearOptions] = await Promise.all([
    query<{
      n: number;
      cn: number;
      eur: number | null;
      rn: number;
      re: number | null;
      dn: number;
      de: number | null;
    }>(
      `SELECT COUNT(*) n, COUNT(DISTINCT eik) cn, SUM(amount_eur) eur, COALESCE(SUM(during_role),0) rn, SUM(CASE WHEN during_role THEN amount_eur END) re, COALESCE(SUM(during_declaration),0) dn, SUM(CASE WHEN during_declaration THEN amount_eur END) de FROM activity${where}`,
    ),
    query<{ eik: string; name: string }>(
      `SELECT DISTINCT eik, company AS name FROM activity WHERE ${optionEligibility} ORDER BY company`,
      [indent ?? '', ...ids],
    ),
    query<{ id: string; name: string }>(
      `SELECT DISTINCT authority_id AS id, authority AS name FROM activity WHERE ${optionEligibility} ORDER BY authority`,
      [indent ?? '', ...ids],
    ),
    query<{ year: string; contracts: number; valueEur: number | null }>(
      `SELECT COALESCE(strftime('%Y',signed_at),'Без дата') year, COUNT(*) contracts, SUM(amount_eur) valueEur FROM activity${where} GROUP BY 1 ORDER BY 1`,
    ),
    query<{ id: string; name: string; contracts: number; valueEur: number | null }>(
      `SELECT authority_id id, authority name, COUNT(*) contracts, SUM(amount_eur) valueEur FROM activity${where} GROUP BY authority_id ORDER BY valueEur DESC`,
    ),
    query<{ year: string }>(
      `SELECT DISTINCT strftime('%Y',signed_at) year FROM activity WHERE strftime('%Y',signed_at) IS NOT NULL ORDER BY year DESC`,
      [indent ?? '', ...ids],
    ),
  ]);
  const t = totals.results[0]!;
  const pageSize = 50;
  const asked = Number(search.get('page') || 1);
  const page = Math.min(
    Math.max(1, Math.ceil(t.n / pageSize)),
    Number.isSafeInteger(asked) && asked > 0 ? asked : 1,
  );
  const rows = await query<{
    id: string;
    subject: string;
    company: string;
    eik: string;
    authority: string;
    authority_id: string;
    signed_at: string | null;
    amount_eur: number | null;
    during_role: number;
    during_declaration: number;
    declaration_basis: number;
  }>(
    `SELECT * FROM activity${where} ORDER BY signed_at DESC, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  );
  return {
    contracts: rows.results.map((r) => ({
      id: r.id,
      subject: r.subject,
      company: r.company,
      eik: r.eik,
      authority: r.authority,
      authorityId: r.authority_id,
      signedAt: r.signed_at,
      valueEur: r.amount_eur,
      duringRole: !!r.during_role,
      duringDeclaration: !!r.during_declaration,
      declarationBasis: r.declaration_basis,
    })),
    page,
    pageSize,
    total: t.n,
    companyCount: t.cn,
    valueEur: t.eur,
    roleCount: t.rn,
    roleEur: t.re,
    declaredCount: t.dn,
    declaredEur: t.de,
    companies: companies.results,
    authorities: authorities.results,
    yearOptions: yearOptions.results.map((r) => r.year),
    years: years.results,
    byAuthority: byAuthority.results,
    filters,
  };
}
