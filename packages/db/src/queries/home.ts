import type { HomeData, HomeTotals } from '@sigma/api-contract';
import {
  toAuthorityListItem,
  toCompanyListItem,
  type AuthorityTotalsRow,
  type CompanyTotalsRow,
} from './rows';
import { listSingleOfferContracts } from './contracts';

export interface HomeTotalsRow {
  contracts: number;
  value_eur: number;
  authorities: number;
  bidders: number;
  suspect: number;
  as_of: string | null;
  refreshed_at: string;
}

/** The KPI strip from a home_totals row; zeroes when the rollup has not run yet. */
export function toHomeTotals(totalsRow: HomeTotalsRow | null): HomeTotals {
  return totalsRow
    ? {
        contracts: totalsRow.contracts,
        valueEur: totalsRow.value_eur,
        authorities: totalsRow.authorities,
        bidders: totalsRow.bidders,
        suspect: totalsRow.suspect,
        asOf: totalsRow.as_of,
        refreshedAt: totalsRow.refreshed_at,
      }
    : {
        contracts: 0,
        valueEur: 0,
        authorities: 0,
        bidders: 0,
        suspect: 0,
        asOf: null,
        refreshedAt: '',
      };
}

// type_groups shown in the home "Министерства, агенции и държавни предприятия" column (everything but
// общини, болници и образование — those live in the full list).
const STATE_TYPES = ['министерство', 'агенция', 'държавна компания', 'друго'];

interface SingleOfferPart {
  value_eur: number;
  contracts: number;
}

/**
 * The national single-offer share, on the one base /analytics and /competition use too (methodology §5):
 * contracts with a known number of offers (bids_received >= 1) and a tender, and their one-offer subset —
 * counted, and valued on positive amounts (competitionTotals, #153). Precomputed with the other corpus-wide
 * totals (facet_counts); a database the refresh has not filled yet counts live.
 */
async function singleOfferTotals(
  db: D1Database,
): Promise<{ one: SingleOfferPart; known: SingleOfferPart }> {
  const stored = await db
    .prepare(
      `SELECT key, value_eur, contracts FROM facet_counts WHERE facet = 'single_offer' AND key IN ('one', 'known')`,
    )
    .all<SingleOfferPart & { key: string }>();
  const one = stored.results?.find((r) => r.key === 'one');
  const known = stored.results?.find((r) => r.key === 'known');
  if (one && known) return { one, known };
  const live = await db
    .prepare(
      `SELECT SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS one_contracts,
              COALESCE(SUM(CASE WHEN c.bids_received = 1 AND c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS one_value,
              COUNT(*) AS known_contracts,
              COALESCE(SUM(CASE WHEN c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS known_value
         FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE c.bids_received >= 1`,
    )
    .first<{
      one_contracts: number | null;
      one_value: number;
      known_contracts: number;
      known_value: number;
    }>();
  return {
    one: { value_eur: live?.one_value ?? 0, contracts: live?.one_contracts ?? 0 },
    known: { value_eur: live?.known_value ?? 0, contracts: live?.known_contracts ?? 0 },
  };
}

/** Home page: the KPI strip (from home_totals), top-10 companies, and the ministries/общини slices. */
export async function getHomeData(db: D1Database): Promise<HomeData> {
  const totalsRow = await db
    .prepare(
      `SELECT contracts, value_eur, authorities, bidders, suspect, as_of, refreshed_at FROM home_totals WHERE id = 1`,
    )
    .first<HomeTotalsRow>();

  const totals = toHomeTotals(totalsRow);

  const placeholders = STATE_TYPES.map(() => '?').join(', ');
  const [companies, ministries, municipalities, recentSingleOffer, topSingleOffer, singleOfferRow] =
    await Promise.all([
      db
        .prepare(
          `SELECT * FROM company_totals WHERE kind <> 'unknown' ORDER BY won_eur DESC, bidder_id LIMIT 10`,
        )
        .all<CompanyTotalsRow>(),
      db
        .prepare(
          `SELECT * FROM authority_totals WHERE type_group IN (${placeholders}) ORDER BY spent_eur DESC, authority_id LIMIT 6`,
        )
        .bind(...STATE_TYPES)
        .all<AuthorityTotalsRow>(),
      db
        .prepare(
          `SELECT * FROM authority_totals WHERE type_group = 'община' ORDER BY spent_eur DESC, authority_id LIMIT 6`,
        )
        .all<AuthorityTotalsRow>(),
      listSingleOfferContracts(db, 'recent', 10),
      listSingleOfferContracts(db, 'value', 10),
      singleOfferTotals(db),
    ]);

  return {
    totals,
    topCompanies: companies.results.map(toCompanyListItem),
    topMinistries: ministries.results.map(toAuthorityListItem),
    topMunicipalities: municipalities.results.map(toAuthorityListItem),
    recentSingleOffer,
    topSingleOffer,
    singleOffer: {
      valueEur: singleOfferRow.one.value_eur,
      contracts: singleOfferRow.one.contracts,
      baseValueEur: singleOfferRow.known.value_eur,
      baseContracts: singleOfferRow.known.contracts,
    },
  };
}
