import { declarationWindow } from './declaration-source';
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
  filterCounts: Record<'company' | 'authority' | 'year' | 'basis', Record<string, number>>;
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
        AND c.signed_at IS NOT NULL AND ${declarationWindow('il', 'c.signed_at')}) AS during_declaration,
      (SELECT COALESCE(SUM(DISTINCT CASE WHEN il.interest_class='private_ownership' THEN 1 ELSE 2 END),0)
        FROM interest_links il WHERE ${gate} AND il.eik=b.eik_normalized AND c.signed_at IS NOT NULL
        AND ${declarationWindow('il', 'c.signed_at')}) AS declaration_basis
    FROM contracts c JOIN bidders b ON b.id=c.bidder_id
    JOIN company_totals cp ON cp.bidder_id='eik:' || b.eik_normalized AND cp.contracts>0
    JOIN tenders t ON t.id=c.tender_id
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
  const scope = personActivityScope(indent, ids);
  const filters = {
    company: /^\d{9}(?:\d{4})?$/.test(search.get('company') ?? '') ? search.get('company')! : '',
    authority: (search.get('authority') ?? '').slice(0, 100),
    year: /^\d{4}$/.test(search.get('year') ?? '') ? search.get('year')! : '',
    basis,
  };
  const basisConditions = {
    role: 'during_role=1',
    declaration: 'during_declaration=1',
    self: '(declaration_basis & 1)<>0',
    family: '(declaration_basis & 2)<>0',
    all: '1=1',
    matched: '(during_role=1 OR during_declaration=1)',
    context: '(during_role=0 AND during_declaration=0)',
  };
  const params = [...scope.params, filters.company, filters.authority, filters.year];
  // Bind all selected values once, including when a facet excludes its own selection.
  const cte = `${scope.cte}, selected AS (SELECT ?${scope.params.length + 1} company,
    ?${scope.params.length + 2} authority, ?${scope.params.length + 3} year)`;
  const conditions = {
    company: filters.company ? 'eik=(SELECT company FROM selected)' : '1=1',
    authority: filters.authority ? 'authority_id=(SELECT authority FROM selected)' : '1=1',
    year: filters.year ? "strftime('%Y',signed_at)=(SELECT year FROM selected)" : '1=1',
    basis: basisConditions[basis],
  };
  const matching = (except?: keyof typeof conditions) =>
    Object.entries(conditions)
      .filter(([key]) => key !== except)
      .map(([, condition]) => condition)
      .join(' AND ');
  const where = ` WHERE ${matching()}`;
  const query = <T>(sql: string) =>
    db
      .prepare(`${cte} ${sql}`)
      .bind(...params)
      .all<T>();
  const [totals, companies, authorities, years, byAuthority, yearOptions, basisCounts] =
    await Promise.all([
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
      query<{ eik: string; name: string; contracts: number }>(
        `SELECT eik, MIN(company) AS name, COUNT(CASE WHEN ${matching('company')} THEN 1 END) contracts
        FROM activity GROUP BY eik ORDER BY name`,
      ),
      query<{ id: string; name: string; contracts: number }>(
        `SELECT authority_id AS id, authority AS name, COUNT(CASE WHEN ${matching('authority')} THEN 1 END) contracts
        FROM activity GROUP BY authority_id, authority ORDER BY authority`,
      ),
      query<{ year: string; contracts: number; valueEur: number | null }>(
        `SELECT COALESCE(strftime('%Y',signed_at),'Без дата') year, COUNT(*) contracts, SUM(amount_eur) valueEur FROM activity${where} GROUP BY 1 ORDER BY 1`,
      ),
      query<{ id: string; name: string; contracts: number; valueEur: number | null }>(
        `SELECT authority_id id, authority name, COUNT(*) contracts, SUM(amount_eur) valueEur FROM activity${where} GROUP BY authority_id ORDER BY valueEur DESC`,
      ),
      query<{ year: string | null; contracts: number }>(
        `SELECT strftime('%Y',signed_at) year, COUNT(CASE WHEN ${matching('year')} THEN 1 END) contracts
        FROM activity GROUP BY year ORDER BY year DESC`,
      ),
      query<Record<keyof typeof basisConditions, number>>(
        `SELECT ${Object.entries(basisConditions)
          .map(([key, condition]) => `COUNT(CASE WHEN ${condition} THEN 1 END) AS "${key}"`)
          .join(',')}
        FROM activity WHERE ${matching('basis')}`,
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
    companies: companies.results.map(({ eik, name }) => ({ eik, name })),
    authorities: authorities.results.map(({ id, name }) => ({ id, name })),
    yearOptions: yearOptions.results.flatMap((r) => (r.year ? [r.year] : [])),
    filterCounts: {
      company: optionCounts(
        companies.results.map((r) => ({ value: r.eik, contracts: r.contracts })),
      ),
      authority: optionCounts(
        authorities.results.map((r) => ({ value: r.id, contracts: r.contracts })),
      ),
      year: optionCounts(
        yearOptions.results.map((r) => ({ value: r.year, contracts: r.contracts })),
      ),
      basis: basisCounts.results[0]!,
    },
    years: years.results,
    byAuthority: byAuthority.results,
    filters,
  };
}

function optionCounts(rows: { value: string | null; contracts: number }[]): Record<string, number> {
  return {
    '': rows.reduce((total, row) => total + row.contracts, 0),
    ...Object.fromEntries(rows.filter((r) => r.value !== null).map((r) => [r.value, r.contracts])),
  };
}
