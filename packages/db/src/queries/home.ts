import type { HomeData, HomeTotals } from '@sigma/api-contract';
import {
  toAuthorityListItem,
  toCompanyListItem,
  type AuthorityTotalsRow,
  type CompanyTotalsRow,
} from './rows';
import { listSingleOfferContracts } from './contracts';

interface HomeTotalsRow {
  contracts: number;
  value_eur: number;
  authorities: number;
  bidders: number;
  suspect: number;
  as_of: string | null;
  refreshed_at: string;
}

// type_groups shown in the home "Министерства, агенции и държавни предприятия" column (everything but
// общини, болници и образование — those live in the full list).
const STATE_TYPES = ['министерство', 'агенция', 'държавна компания', 'друго'];

/** Home page: the KPI strip (from home_totals), top-10 companies, and the ministries/общини slices. */
export async function getHomeData(db: D1Database): Promise<HomeData> {
  const totalsRow = await db
    .prepare(
      `SELECT contracts, value_eur, authorities, bidders, suspect, as_of, refreshed_at FROM home_totals WHERE id = 1`,
    )
    .first<HomeTotalsRow>();

  const totals: HomeTotals = totalsRow
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

  const placeholders = STATE_TYPES.map(() => '?').join(', ');
  const [companies, ministries, municipalities, recentSingleOffer, topSingleOffer, singleOfferRow] =
    await Promise.all([
      db
        .prepare(`SELECT * FROM company_totals ORDER BY won_eur DESC, bidder_id LIMIT 10`)
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
      // Money portion of single-offer contracts vs the whole corpus (totals.valueEur is the
      // denominator). Same clean-row basis as the single-offer list above: bids = 1, non-suspect,
      // positive amount. Edge-cached for an hour, so the full scan runs rarely.
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_eur), 0) AS value_eur, COUNT(*) AS contracts
         FROM contracts WHERE bids_received = 1 AND value_flag = 'ok' AND amount_eur > 0`,
        )
        .first<{ value_eur: number; contracts: number }>(),
    ]);

  return {
    totals,
    topCompanies: companies.results.map(toCompanyListItem),
    topMinistries: ministries.results.map(toAuthorityListItem),
    topMunicipalities: municipalities.results.map(toAuthorityListItem),
    recentSingleOffer,
    topSingleOffer,
    singleOffer: {
      valueEur: singleOfferRow?.value_eur ?? 0,
      contracts: singleOfferRow?.contracts ?? 0,
    },
  };
}
