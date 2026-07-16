// Flagged value (issue #218): the total € running through contracts that carry a risk signal, plus a
// breakdown by signal type and by category. Computed LIVE over existing columns (no schema/precompute
// change) — the caller edge-caches it for an hour, same basis as the single-offer scan in home.ts.
//
// The signal predicates mirror the per-contract RiskIndicators (apps/web/app/lib/riskLogic.ts) so the
// homepage number stays consistent with the badge a visitor sees on a contract page. Keep FLAG_TYPES in
// sync with riskLogic's RiskFlagType (asserted by flagged.test.ts). `c` is the `contracts` alias.

import { CPV_SECTORS } from '@sigma/config';
import type { FlaggedValue } from '@sigma/api-contract';

// The "unconfirmed value" flags (mirrors details.ts value.suspect: value_suspect | annex_suspect |
// review | value_low). Kept as a SQL list literal so the fragments read cleanly.
const SUSPECT_VALUE_FLAGS = "('value_suspect', 'annex_suspect', 'review', 'value_low')";

/** Per-signal SQL predicates — the single source of truth reused by the aggregate and the /contracts
 *  `flag` filter. Each is a self-contained boolean over the `contracts c` row. */
export const FLAG_SQL = {
  // Admitted bids (received − rejected) == 1, without EU funding.
  no_competition:
    'c.bids_received IS NOT NULL AND (c.bids_received - COALESCE(c.bids_rejected, 0)) = 1 ' +
    'AND (c.eu_funded IS NULL OR c.eu_funded = 0)',
  // Same, but EU-funded (surfaced separately, like riskLogic).
  eu_no_competition:
    'c.bids_received IS NOT NULL AND (c.bids_received - COALESCE(c.bids_rejected, 0)) = 1 ' +
    'AND c.eu_funded = 1',
  // Current value grew > 20% over the signing value (annex-driven cost growth); non-suspect only, so a
  // value anomaly isn't double-counted here (mirrors details.ts deltaPct, which is null when suspect).
  // Guard `signing_value_eur > 0` (not just `<> 0`): riskLogic's badge fires on deltaPct = (current −
  // signing)/signing > 0.2, which for a NEGATIVE base is NOT algebraically equal to
  // (current − signing) > 0.2·signing — so `<> 0` would count a negative-base row here that the contract
  // page never badges. `> 0` makes the aggregate and the per-contract badge provably identical (#236 review).
  high_markup:
    `c.value_flag NOT IN ${SUSPECT_VALUE_FLAGS} AND c.signing_value_eur IS NOT NULL ` +
    'AND c.signing_value_eur > 0 AND (c.current_value_eur - c.signing_value_eur) > 0.2 * c.signing_value_eur',
  // Value or date anomaly.
  anomalies: `c.date_flag = 'signed_after_publication' OR c.value_flag IN ${SUSPECT_VALUE_FLAGS}`,
} as const;

export type FlagType = keyof typeof FLAG_SQL;
export const FLAG_TYPES = Object.keys(FLAG_SQL) as FlagType[];

/** A contract is "flagged" when it carries at least one signal. Each predicate is parenthesised because
 *  `anomalies` is itself an OR. */
export const ANY_FLAG_SQL = FLAG_TYPES.map((t) => `(${FLAG_SQL[t]})`).join(' OR ');

/** Map a filter token (a FlagType, or `all`) to a WHERE fragment. Unknown tokens → null (ignored). */
export function flagPredicate(token: string): string | null {
  if (token === 'all') return ANY_FLAG_SQL;
  return token in FLAG_SQL ? FLAG_SQL[token as FlagType] : null;
}

const SECTOR_LABEL = new Map(CPV_SECTORS.map((s) => [s.code, s.short ?? s.label]));

const FROM = `FROM contracts c
  JOIN tenders t ON t.id = c.tender_id
  JOIN authorities a ON a.id = t.authority_id`;

interface TotalRow {
  total_eur: number;
  total_contracts: number;
  [k: string]: number;
}
interface SectorRow {
  code: string | null;
  eur: number;
  contracts: number;
}
interface AuthTypeRow {
  type_group: string | null;
  eur: number;
  contracts: number;
}

/**
 * Homepage flagged-value summary. Money (€) sums only trustworthy figures — `SUM(amount_eur)` skips the
 * NULLs the ETL leaves on unrecoverable `value_suspect` rows (canonical basis, #98) — while the CONTRACT
 * tally counts every flagged row, so a value-suspect contract is counted but contributes €0. The `byType`
 * slices OVERLAP (a contract can be both single-offer and cost-growth), so they sum to more than the
 * de-duplicated total. `bySector` (top 6) and `byAuthorityType` are TOP slices that need not sum to the
 * total: flagged rows with a NULL `cpv_code`/`type_group` are excluded, and `bySector` is capped at 6.
 */
export async function getFlaggedValue(db: D1Database): Promise<FlaggedValue> {
  const typeCols = FLAG_TYPES.flatMap((t) => [
    `COALESCE(SUM(CASE WHEN (${FLAG_SQL[t]}) THEN c.amount_eur END), 0) AS ${t}_eur`,
    `COUNT(CASE WHEN (${FLAG_SQL[t]}) THEN 1 END) AS ${t}_n`,
  ]);

  const [totalRow, sectors, authTypes] = await Promise.all([
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN (${ANY_FLAG_SQL}) THEN c.amount_eur END), 0) AS total_eur,
           COUNT(CASE WHEN (${ANY_FLAG_SQL}) THEN 1 END) AS total_contracts,
           ${typeCols.join(',\n           ')}
         FROM contracts c`,
      )
      .first<TotalRow>(),
    db
      .prepare(
        `SELECT substr(t.cpv_code, 1, 2) AS code,
                COALESCE(SUM(c.amount_eur), 0) AS eur, COUNT(*) AS contracts
         ${FROM}
         WHERE (${ANY_FLAG_SQL}) AND t.cpv_code IS NOT NULL
         GROUP BY code ORDER BY eur DESC LIMIT 6`,
      )
      .all<SectorRow>(),
    db
      .prepare(
        `SELECT a.type_group AS type_group,
                COALESCE(SUM(c.amount_eur), 0) AS eur, COUNT(*) AS contracts
         ${FROM}
         WHERE (${ANY_FLAG_SQL}) AND a.type_group IS NOT NULL
         GROUP BY a.type_group ORDER BY eur DESC`,
      )
      .all<AuthTypeRow>(),
  ]);

  const byType = FLAG_TYPES.map((t) => ({
    type: t,
    eur: totalRow?.[`${t}_eur`] ?? 0,
    contracts: totalRow?.[`${t}_n`] ?? 0,
  }));

  return {
    totalEur: totalRow?.total_eur ?? 0,
    contracts: totalRow?.total_contracts ?? 0,
    byType,
    bySector: sectors.results
      .filter((r): r is SectorRow & { code: string } => r.code != null)
      .map((r) => ({
        code: r.code,
        label: SECTOR_LABEL.get(r.code) ?? r.code,
        eur: r.eur,
        contracts: r.contracts,
      })),
    byAuthorityType: authTypes.results
      .filter((r): r is AuthTypeRow & { type_group: string } => r.type_group != null)
      .map((r) => ({ typeGroup: r.type_group, eur: r.eur, contracts: r.contracts })),
  };
}
