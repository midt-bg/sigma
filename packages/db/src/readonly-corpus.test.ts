import { describe, expect, it } from 'vitest';
import {
  contractSitemapPages,
  getAuthority,
  getAuthorityFacets,
  getCompany,
  getCompanyFacets,
  getCompetition,
  getCompetitionSummary,
  getContract,
  getContractFacets,
  getEntityNetwork,
  getFlows,
  getHomeData,
  getMethodologyStats,
  getRegionalSpending,
  getSpendingTrend,
  listAuthorities,
  listCompanies,
  listContracts,
  search,
  streamAuthoritiesCsv,
  streamAuthoritySitemap,
  streamCompaniesCsv,
  streamCompanySitemap,
  streamContractSitemap,
  streamContractsCsv,
} from './queries';
import { isReadOnlySql } from './readonly-sql';

// Regression guard for the #199 read-only D1 wrapper: the wrapper's predicate must never reject a real
// loader query (a false-reject 500s a live page). This drives every read loader — including the dynamic
// list loaders with BOTH an unfiltered and a fully-filtered param set, so the runtime-assembled WHERE /
// ORDER BY branches are exercised — against a capturing fake D1, then asserts every emitted statement is
// read-only. The loaders post-process rows; we feed empty canned rows, so some post-processing rejects —
// irrelevant here (each loader's own unit test covers results), and the SQL is already captured at
// prepare() time, so we swallow those rejections and assert only on the captured SQL.
function capturingDb(): { db: D1Database; captured: string[] } {
  const captured: string[] = [];
  const zero = new Proxy({}, { get: () => 0 });
  const stmt = {
    bind() {
      return stmt;
    },
    async all() {
      return { results: [], success: true, meta: {} };
    },
    async first() {
      return zero;
    },
    async raw() {
      return [];
    },
    async run() {
      return { results: [], success: true, meta: {} };
    },
  };
  const db = {
    prepare(sql: string) {
      captured.push(sql);
      return stmt;
    },
    async exec(sql: string) {
      captured.push(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return { db, captured };
}

const swallow = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);

type Params<F> = F extends (db: D1Database, p: infer P, ...rest: never[]) => unknown ? P : never;

const contractsUnfiltered = {
  sort: 'value-desc',
  years: [],
  sectors: [],
  procedureGroups: [],
  valueBucket: null,
  eu: null,
  authority: null,
  bidder: null,
  q: null,
  bids: null,
  cursor: null,
  pageSize: 15,
} as unknown as Params<typeof listContracts>;
const contractsFiltered = {
  ...contractsUnfiltered,
  years: ['2024'],
  sectors: ['45'],
  procedureGroups: ['open'],
  valueBucket: '1m-5m',
  eu: 'eu',
  authority: 'auth:100000001',
  bidder: 'eik:200000001',
  q: 'път',
  bids: 'one',
} as unknown as Params<typeof listContracts>;

const companiesUnfiltered = {
  sort: 'won',
  kinds: [],
  countBucket: null,
  sectors: [],
  years: [],
  eu: null,
  q: null,
  cursor: null,
  pageSize: 25,
} as unknown as Params<typeof listCompanies>;
const companiesFiltered = {
  ...companiesUnfiltered,
  kinds: ['company'],
  countBucket: '2-5',
  sectors: ['45'],
  years: ['2024'],
  eu: 'national',
  q: 'строителство',
} as unknown as Params<typeof listCompanies>;

const authoritiesUnfiltered = {
  sort: 'spent',
  types: [],
  sectors: [],
  years: [],
  eu: null,
  q: null,
  cursor: null,
  pageSize: 25,
} as unknown as Params<typeof listAuthorities>;
const authoritiesFiltered = {
  ...authoritiesUnfiltered,
  types: ['municipality'],
  sectors: ['45'],
  years: ['2024'],
  eu: 'eu',
  q: 'път',
} as unknown as Params<typeof listAuthorities>;

const flowsParams = { sector: null, year: null, funding: 'all', top: 20 } as unknown as Params<
  typeof getFlows
>;
const trendParams = {
  granularity: 'month',
  sector: null,
  funding: 'all',
} as unknown as Params<typeof getSpendingTrend>;
const competitionParams = {
  sector: null,
  year: null,
  funding: 'all',
  top: 20,
  minContracts: 5,
} as unknown as Params<typeof getCompetition>;
const networkParams = { center: 'auth:100000001' } as unknown as Params<typeof getEntityNetwork>;
const regionalParams = { sector: null, year: null, funding: 'all' } as unknown as Params<
  typeof getRegionalSpending
>;

// The CSV/sitemap streamers query lazily inside a ReadableStream — reading the body drains them so
// their SQL is captured too.
const drain = (res: Response): Promise<unknown> => res.text().catch(() => undefined);

describe('read-loader corpus is read-only', () => {
  it('emits only read-only SQL across every read loader (no false-reject)', async () => {
    const { db, captured } = capturingDb();

    await Promise.all([
      swallow(getHomeData(db)),
      swallow(getMethodologyStats(db)),
      swallow(getContractFacets(db)),
      swallow(getCompanyFacets(db)),
      swallow(getAuthorityFacets(db)),
      swallow(getCompetitionSummary(db)),
      swallow(listContracts(db, contractsUnfiltered)),
      swallow(listContracts(db, contractsFiltered)),
      swallow(listCompanies(db, companiesUnfiltered)),
      swallow(listCompanies(db, companiesFiltered)),
      swallow(listAuthorities(db, authoritiesUnfiltered)),
      swallow(listAuthorities(db, authoritiesFiltered)),
      swallow(getFlows(db, flowsParams)),
      swallow(getSpendingTrend(db, trendParams)),
      swallow(getCompetition(db, competitionParams)),
      swallow(getEntityNetwork(db, null)),
      swallow(getEntityNetwork(db, networkParams)),
      swallow(search(db, 'софия строителство')),
      swallow(getCompany(db, 'eik:200000001')),
      swallow(getAuthority(db, 'auth:100000001')),
      swallow(getContract(db, 'e:UNP-1:CONTRACT-1')),
      swallow(getRegionalSpending(db, regionalParams)),
      swallow(contractSitemapPages(db)),
      drain(streamContractsCsv(db, contractsFiltered)),
      drain(streamCompaniesCsv(db, companiesFiltered)),
      drain(streamAuthoritiesCsv(db, authoritiesFiltered)),
      drain(streamContractSitemap(db, 'https://sigma.bg', 1)),
      drain(streamCompanySitemap(db, 'https://sigma.bg')),
      drain(streamAuthoritySitemap(db, 'https://sigma.bg')),
    ]);

    // Non-vacuity (rule-compliant, not a range): a broken import would capture nothing and vacuously
    // pass — prove a representative loader emitted SQL, then assert every captured statement is read-only.
    expect(captured.some((sql) => sql.includes('home_totals'))).toBe(true);
    expect(captured.filter((sql) => !isReadOnlySql(sql))).toEqual([]);
  });
});
