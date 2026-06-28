// Overruns („Раздуване") — the corpus-wide view of contracts that ballooned after signing via
// annexes. An overrun is a contract whose post-annex value (current_value_eur) exceeds its value at
// signing (signing_value_eur), with both figures present and at least one annex on record. The annex
// data is already promoted to the served DB (precompute fills *_eur; annex_suspect rows have a NULL
// current_value_eur and so are excluded honestly here). Read-only, edge-cached at the route; mirrors
// the live-aggregation style of flows.ts / competition.ts — no new rollup table.
//
// delta = current − signing; pct = delta / signing. signing_value_eur is required to be >= €1 000 in the
// WHERE (data-quality guard + makes the pct division safe); the JS mapping double-guards so a stray
// non-positive signing can never produce an Infinity/NaN pct.
//
// The page issues exactly five bounded queries (see getOverrunsAnalytics): one leaderboard (LIMIT-ed),
// one corpus aggregate (single pass, conditional SUM/AVG — no duplicate COUNT), one median, and one
// each for the by-authority and by-sector breakdowns (each GROUP BY is bounded by its key cardinality
// and the leaderboard carries a LIMIT). The shared OVERRUN_WHERE keeps every aggregate's definition of
// "ballooned" identical. The route adds one more bounded query for the shown contracts' annex history.

import { cleanName, entityName } from '@sigma/shared';
import { CPV_SECTORS, cpvBucket, type CpvBucket } from '@sigma/config';
import { authoritySlug, companySlug, contractSlug } from './identity';

export interface OverrunRow {
  contractId: string;
  contractSlug: string;
  subject: string;
  authorityName: string;
  authoritySlug: string;
  /** Authority ЕИК (the authority-route key) — for the inspector „Възложител · ЕИК" line. */
  authorityEik: string;
  bidderName: string;
  bidderSlug: string;
  /** Bidder ЕИК (digits-only, NULL for name-keyed bidders without a valid ЕИК). */
  bidderEik: string | null;
  signingEur: number;
  currentEur: number;
  deltaEur: number;
  pct: number;
  annexCount: number;
  // ── real contract metadata for the inspector „ДЕТАЙЛИ ПО ДОГОВОРА" grid ──
  /** Curated CPV-division label (e.g. „Строителство"), from the CPV code's first two digits. */
  sectorLabel: string;
  cpvCode: string | null;
  cpvDescription: string | null;
  procedureType: string | null;
  /** true = EU-funded, false = national, null = unknown. */
  euFunded: boolean | null;
  /** Operational programme name when present (contract-level, falling back to tender-level). */
  euProgramme: string | null;
  signedAt: string | null;
  /** Тender „Очакван край" (end_date) — the contract term date; drives the „Срок" row + status badge. */
  endDate: string | null;
  /** Contract „Срок за изпълнение" in days (contracts.duration_days); a term fallback when no end_date. */
  durationDays: number | null;
}

// One real amendment of an overrun contract — the rows behind „История на анексите · N". Sourced from
// the `amendments` history table (value_before/after/delta + published_at + description), joined to the
// contract via (tender.source_id = amendments.unp, contracts.contract_number = amendments.contract_number).
// Native amendment values are normalised to EUR here (peg for BGN, identity for EUR) so the inspector's
// +Δ reads in the same unit as the rest of the page; a foreign currency without an fx rate yields null
// (omitted honestly rather than shown in the wrong unit).
export interface OverrunAnnex {
  contractId: string;
  /** Amendment publication date (ISO, may be NULL when the source omits it). */
  date: string | null;
  /** Reason / circumstances of the amendment (`description`); NULL when the source omits it. */
  reason: string | null;
  valueBeforeEur: number | null;
  valueAfterEur: number | null;
  /** Post-minus-pre value change in EUR; NULL when the currency can't be normalised. */
  deltaEur: number | null;
}

export interface OverrunsResult {
  rows: OverrunRow[];
  totalOverrunEur: number;
  count: number;
}

export interface OverrunsParams {
  by: 'absolute' | 'percent';
  limit?: number;
}

// Corpus headline figures for the whole overrun set. `shareOfSigning` puts the inflation in context:
// the total ballooning measured against the corpus-wide signed value — the sum of EVERY contract's
// signing_value_eur where it is present and positive. That denominator is intentionally corpus-wide:
// it includes contracts that never ballooned and annex-suspect rows (whose signing value is still
// trustworthy even though their post-annex value is suppressed). It does NOT special-case suspect
// rows out — see `corpus_signing_eur` below for the exact SQL.
export interface OverrunCorpus {
  totalOverrunEur: number;
  count: number;
  avgPct: number;
  medianPct: number;
  corpusSigningEur: number;
  shareOfSigning: number;
}

export interface OverrunAuthorityRow {
  authorityName: string;
  authoritySlug: string;
  totalOverrunEur: number;
  count: number;
  /** Aggregate growth for the authority = SUM(delta) / SUM(signing) — the real ballooning ratio of
   *  its overrun portfolio, NOT an average of per-contract pcts (which over-weights tiny contracts). */
  growth: number;
}

export interface OverrunSectorRow {
  /** 2-digit CPV division code. */
  code: string;
  /** Curated CPV-division label (short name for featured divisions, else the official BG label). */
  label: string;
  /** Works / goods / services / other — drives the sector-table row's dot colour + legend. */
  bucket: CpvBucket;
  /** € at risk = SUM(delta) of the division's overrun contracts (the sector table's „€ риск" column). */
  riskEur: number;
  /** Aggregate growth = SUM(delta) / SUM(signing) over the division's overrun contracts (truthful
   *  €-weighted ratio, not an average of per-contract pcts). */
  growth: number;
  /** Number of overrun contracts in the division. */
  contracts: number;
}

export interface OverrunsAnalytics {
  corpus: OverrunCorpus;
  rows: OverrunRow[];
  byAuthority: OverrunAuthorityRow[];
  bySector: OverrunSectorRow[];
}

export interface OverrunsAnalyticsParams {
  by: 'absolute' | 'percent';
  leaderboardLimit?: number;
  authorityLimit?: number;
  sectorLimit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const AUTHORITY_LIMIT = 20;
const SECTOR_LIMIT = 15;

// The overrun predicate, shared by every query so they never disagree on what counts as a ballooned
// contract. Uses only `contracts` columns (aliased `c`) so it works both as a WHERE and as a CASE
// condition in the single-pass corpus aggregate.
// Data-quality floor: the signing value must be at least €1 000. Many source rows carry a 0 or
// near-zero signing amount (placeholder / not-yet-filled), which makes pct = delta/signing explode to
// thousands of percent ("+4818%", "от 0 €") and dominate the charts with artefacts rather than real
// overruns. Requiring ≥ €1 000 keeps the ratio meaningful.
const OVERRUN_MIN_SIGNING_EUR = 1000;
const OVERRUN_WHERE = `c.signing_value_eur IS NOT NULL
       AND c.current_value_eur IS NOT NULL
       AND c.annex_count > 0
       AND c.current_value_eur > c.signing_value_eur
       AND c.signing_value_eur >= ${OVERRUN_MIN_SIGNING_EUR}`;

// delta / pct / signing expressions, reused across aggregates so the maths is defined once. SIGNING is
// the per-row signed value; SUM(DELTA)/SUM(SIGNING) gives the truthful €-weighted growth of a group.
const DELTA = '(c.current_value_eur - c.signing_value_eur)';
const PCT = '(c.current_value_eur - c.signing_value_eur) / c.signing_value_eur';
const SIGNING = 'c.signing_value_eur';

interface RawRow {
  contract_id: string;
  subject: string;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  bidder_eik: string | null;
  signing_eur: number;
  current_eur: number;
  annex_count: number;
  cpv_code: string | null;
  cpv_description: string | null;
  procedure_type: string | null;
  eu_funded: number | null;
  eu_programme: string | null;
  signed_at: string | null;
  end_date: string | null;
  duration_days: number | null;
}

const PEG = 1.95583;

// Native amendment value → EUR. Peg for BGN, identity for EUR; any other currency has no fx rate on the
// `amendments` row, so it returns null (the inspector then omits the figure rather than mis-stating it).
function annexEur(value: number | null, currency: string | null): number | null {
  if (value == null) return null;
  // A NULL currency is ASSUMED BGN — the source's default for this feed, not a known-BGN flag. A
  // genuinely-EUR row that omitted its currency would be mis-pegged (÷PEG); acceptable for a
  // BGN-default feed, documented here so the assumption is explicit rather than silent.
  const c = (currency ?? 'BGN').toUpperCase();
  if (c === 'EUR') return value;
  if (c === 'BGN') return value / PEG;
  return null;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const requested = Number.isInteger(limit) ? limit! : fallback;
  return requested >= 1 && requested <= max ? requested : fallback;
}

// ORDER BY for the leaderboard: absolute lev overrun, or percentage blow-up. Both are safe (signing >
// 0 in WHERE); ties break on contract id for a stable order.
function leaderboardOrderBy(by: 'absolute' | 'percent'): string {
  return by === 'percent' ? `${PCT} DESC, c.id` : `${DELTA} DESC, c.id`;
}

function leaderboardSql(by: 'absolute' | 'percent'): string {
  return `SELECT c.id AS contract_id,
                COALESCE(NULLIF(TRIM(c.contract_subject), ''), t.title) AS subject,
                t.authority_id AS authority_id, a.name AS authority_name,
                c.bidder_id AS bidder_id, b.name AS bidder_name, b.kind AS bidder_kind,
                b.eik_normalized AS bidder_eik,
                c.signing_value_eur AS signing_eur, c.current_value_eur AS current_eur,
                c.annex_count AS annex_count,
                t.cpv_code AS cpv_code, t.cpv_description AS cpv_description,
                t.procedure_type AS procedure_type,
                c.eu_funded AS eu_funded,
                COALESCE(c.eu_programme, t.eu_programme) AS eu_programme,
                c.signed_at AS signed_at,
                t.end_date AS end_date,
                c.duration_days AS duration_days
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         JOIN authorities a ON a.id = t.authority_id
         JOIN bidders b ON b.id = c.bidder_id
         WHERE ${OVERRUN_WHERE}
         ORDER BY ${leaderboardOrderBy(by)}
         LIMIT ?`;
}

// Map raw leaderboard rows to the API shape. Belt-and-suspenders: re-apply the €1 000 signing floor
// (never trust the WHERE alone) so a near-zero signing can't yield an Infinity/NaN or runaway pct.
function mapOverrunRows(raw: RawRow[]): OverrunRow[] {
  return raw
    .filter((r) => r.signing_eur >= OVERRUN_MIN_SIGNING_EUR && r.current_eur > r.signing_eur)
    .map((r) => {
      const deltaEur = r.current_eur - r.signing_eur;
      const bidderName = cleanName(r.bidder_name);
      const division = (r.cpv_code ?? '').slice(0, 2);
      return {
        contractId: r.contract_id,
        contractSlug: contractSlug(r.contract_id),
        subject: r.subject,
        authorityName: cleanName(r.authority_name),
        authoritySlug: authoritySlug(r.authority_id),
        authorityEik: authoritySlug(r.authority_id),
        bidderName: entityName(bidderName, r.bidder_kind),
        bidderSlug: companySlug(r.bidder_id),
        bidderEik: r.bidder_eik ?? null,
        signingEur: r.signing_eur,
        currentEur: r.current_eur,
        deltaEur,
        pct: deltaEur / r.signing_eur,
        annexCount: r.annex_count,
        sectorLabel: SECTOR_LABELS.get(division) ?? (division ? `Сектор ${division}` : 'Без код'),
        cpvCode: r.cpv_code ?? null,
        cpvDescription: r.cpv_description ?? null,
        procedureType: r.procedure_type ?? null,
        euFunded: r.eu_funded == null ? null : r.eu_funded === 1,
        euProgramme: r.eu_programme ?? null,
        signedAt: r.signed_at ?? null,
        endDate: r.end_date ?? null,
        durationDays: r.duration_days ?? null,
      };
    });
}

interface AnnexRaw {
  contract_id: string;
  value_before: number | null;
  value_after: number | null;
  value_delta: number | null;
  currency: string | null;
  published_at: string | null;
  description: string | null;
}

// The real annex history for the contracts CURRENTLY SHOWN in the leaderboard — one bounded query, not
// a per-row round trip. The inspector is client-selected, so we pre-fetch every displayed contract's
// amendments here and the route renders the selected row's slice from memory.
//
// Cost: ONE statement. The IN-list is bounded by the leaderboard LIMIT (≤ MAX_LIMIT = 200 ids; default
// 50), so the parameter count and the join fan-out are both bounded. The join rides idx_amendments_contract
// (unp, contract_number); rows out = the total amendments across the shown contracts (each overrun
// contract has annex_count > 0, typically a handful). No N+1, no unbounded scan, no duplicate COUNT.
export async function getOverrunAnnexes(
  db: D1Database,
  contractIds: string[],
): Promise<OverrunAnnex[]> {
  if (contractIds.length === 0) return [];
  const placeholders = contractIds.map(() => '?').join(', ');
  const res = await db
    .prepare(
      `SELECT c.id AS contract_id,
              am.value_before AS value_before, am.value_after AS value_after,
              am.value_delta AS value_delta, am.currency AS currency,
              am.published_at AS published_at, am.description AS description
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN amendments am ON am.unp = t.source_id AND am.contract_number = c.contract_number
       WHERE c.id IN (${placeholders})
       ORDER BY c.id, am.published_at, am.natural_key`,
    )
    .bind(...contractIds)
    .all<AnnexRaw>();

  return res.results.map((r) => {
    const valueBeforeEur = annexEur(r.value_before, r.currency);
    const valueAfterEur = annexEur(r.value_after, r.currency);
    let deltaEur = annexEur(r.value_delta, r.currency);
    if (deltaEur == null && valueBeforeEur != null && valueAfterEur != null) {
      deltaEur = valueAfterEur - valueBeforeEur;
    }
    return {
      contractId: r.contract_id,
      date: r.published_at ?? null,
      reason: r.description?.trim() || null,
      valueBeforeEur,
      valueAfterEur,
      deltaEur,
    };
  });
}

const SECTOR_LABELS = new Map(CPV_SECTORS.map((s) => [s.code, s.short ?? s.label]));

// Lean corpus headline for the /analytics landing card — just the two figures the card shows
// (total ballooning € + median growth ratio), in ONE statement. Mirrors the definitions in
// getOverrunsAnalytics (same OVERRUN_WHERE, same DELTA / median window) so the landing never
// disagrees with the /overruns dashboard. Two scalar subqueries → one round trip.
export interface OverrunsHeadline {
  totalOverrunEur: number;
  medianPct: number;
}

export async function getOverrunsHeadline(db: D1Database): Promise<OverrunsHeadline> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(${DELTA}), 0) FROM contracts c WHERE ${OVERRUN_WHERE}) AS total_overrun_eur,
         (SELECT COALESCE(AVG(pct), 0) FROM (
            SELECT pct,
                   ROW_NUMBER() OVER (ORDER BY pct) AS rn,
                   COUNT(*) OVER () AS n
            FROM (
              SELECT ${PCT} AS pct FROM contracts c WHERE ${OVERRUN_WHERE}
            )
          ) WHERE rn IN ((n + 1) / 2, (n + 2) / 2)) AS median_pct`,
    )
    .first<{ total_overrun_eur: number; median_pct: number }>();
  return {
    totalOverrunEur: row?.total_overrun_eur ?? 0,
    medianPct: row?.median_pct ?? 0,
  };
}

export async function getTopOverruns(
  db: D1Database,
  { by, limit }: OverrunsParams,
): Promise<OverrunsResult> {
  const capped = clampLimit(limit, DEFAULT_LIMIT, MAX_LIMIT);

  const [rowsRes, totalsRow] = await Promise.all([
    db.prepare(leaderboardSql(by)).bind(capped).all<RawRow>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(c.current_value_eur - c.signing_value_eur), 0) AS total_overrun_eur,
                COUNT(*) AS count
         FROM contracts c
         WHERE ${OVERRUN_WHERE}`,
      )
      .first<{ total_overrun_eur: number; count: number }>(),
  ]);

  return {
    rows: mapOverrunRows(rowsRes.results),
    totalOverrunEur: totalsRow?.total_overrun_eur ?? 0,
    count: totalsRow?.count ?? 0,
  };
}

interface CorpusRaw {
  total_overrun_eur: number;
  count: number;
  avg_pct: number;
  corpus_signing_eur: number;
}

interface AuthorityRaw {
  authority_id: string;
  authority_name: string;
  total_overrun_eur: number;
  signing_eur: number;
  count: number;
}

interface SectorRaw {
  division: string | null;
  risk_eur: number;
  signing_eur: number;
  count: number;
}

// The full analytical page in five bounded queries. None duplicates another's COUNT/SUM: the corpus
// totals come from the single conditional-aggregate pass, the leaderboard carries a LIMIT, and every
// GROUP BY is bounded by its key (authorities/sectors LIMIT-ed). The authority and sector aggregates
// both carry SUM(signing) alongside SUM(delta) so the displayed РАСТЕЖ is the real €-weighted growth.
export async function getOverrunsAnalytics(
  db: D1Database,
  { by, leaderboardLimit, authorityLimit, sectorLimit }: OverrunsAnalyticsParams,
): Promise<OverrunsAnalytics> {
  const boardLimit = clampLimit(leaderboardLimit, DEFAULT_LIMIT, MAX_LIMIT);
  const authLimit = clampLimit(authorityLimit, AUTHORITY_LIMIT, MAX_LIMIT);
  const secLimit = clampLimit(sectorLimit, SECTOR_LIMIT, MAX_LIMIT);

  const [rowsRes, corpusRow, medianRow, authRes, sectorRes] = await Promise.all([
    db.prepare(leaderboardSql(by)).bind(boardLimit).all<RawRow>(),
    // Single pass over contracts: conditional SUM/AVG so the overrun totals and the corpus signing
    // denominator come from ONE scan, never a duplicate COUNT. `corpus_signing_eur` is corpus-wide
    // (every contract with a present, positive signing value — see OverrunCorpus); it is the
    // denominator for shareOfSigning, not the overrun subset's own signed value.
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN ${OVERRUN_WHERE} THEN ${DELTA} END), 0) AS total_overrun_eur,
           COALESCE(SUM(CASE WHEN ${OVERRUN_WHERE} THEN 1 ELSE 0 END), 0) AS count,
           COALESCE(AVG(CASE WHEN ${OVERRUN_WHERE} THEN ${PCT} END), 0) AS avg_pct,
           COALESCE(SUM(CASE WHEN c.signing_value_eur IS NOT NULL AND c.signing_value_eur > 0
                            THEN c.signing_value_eur END), 0) AS corpus_signing_eur
         FROM contracts c`,
      )
      .first<CorpusRaw>(),
    // Median overrun pct via a window-function pass over the overrun subset; returns the one (odd n)
    // or two (even n) middle rows and averages them. One row out — bounded.
    db
      .prepare(
        `SELECT COALESCE(AVG(pct), 0) AS median_pct
         FROM (
           SELECT pct,
                  ROW_NUMBER() OVER (ORDER BY pct) AS rn,
                  COUNT(*) OVER () AS n
           FROM (
             SELECT ${PCT} AS pct
             FROM contracts c
             WHERE ${OVERRUN_WHERE}
           )
         )
         WHERE rn IN ((n + 1) / 2, (n + 2) / 2)`,
      )
      .first<{ median_pct: number }>(),
    // By-authority: total overrun €, the SUM of signing values (the РАСТЕЖ denominator → real
    // €-weighted growth, not avg-of-pcts), and the contract count. ONE bounded GROUP BY, LIMIT-ed.
    db
      .prepare(
        `SELECT t.authority_id AS authority_id, a.name AS authority_name,
                SUM(${DELTA}) AS total_overrun_eur,
                SUM(${SIGNING}) AS signing_eur,
                COUNT(*) AS count
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         JOIN authorities a ON a.id = t.authority_id
         WHERE ${OVERRUN_WHERE}
         GROUP BY t.authority_id, a.name
         ORDER BY total_overrun_eur DESC, t.authority_id
         LIMIT ?`,
      )
      .bind(authLimit)
      .all<AuthorityRaw>(),
    // By-sector (CPV division): € at risk (SUM delta), the SUM of signing (growth denominator) and the
    // contract count. ONE bounded GROUP BY over OVERRUN_WHERE rows, ordered by risk desc, LIMIT-ed. The
    // works/goods/services bucket is resolved in JS from @sigma/config (no per-row CASE in SQL).
    db
      .prepare(
        `SELECT substr(t.cpv_code, 1, 2) AS division,
                SUM(${DELTA}) AS risk_eur,
                SUM(${SIGNING}) AS signing_eur,
                COUNT(*) AS count
         FROM contracts c
         JOIN tenders t ON t.id = c.tender_id
         WHERE ${OVERRUN_WHERE}
         GROUP BY division
         ORDER BY risk_eur DESC, division
         LIMIT ?`,
      )
      .bind(secLimit)
      .all<SectorRaw>(),
  ]);

  const totalOverrunEur = corpusRow?.total_overrun_eur ?? 0;
  const corpusSigningEur = corpusRow?.corpus_signing_eur ?? 0;
  const corpus: OverrunCorpus = {
    totalOverrunEur,
    count: corpusRow?.count ?? 0,
    avgPct: corpusRow?.avg_pct ?? 0,
    medianPct: medianRow?.median_pct ?? 0,
    corpusSigningEur,
    shareOfSigning: corpusSigningEur > 0 ? totalOverrunEur / corpusSigningEur : 0,
  };

  const byAuthority: OverrunAuthorityRow[] = authRes.results.map((r) => ({
    authorityName: cleanName(r.authority_name),
    authoritySlug: authoritySlug(r.authority_id),
    totalOverrunEur: r.total_overrun_eur,
    count: r.count,
    growth: r.signing_eur > 0 ? r.total_overrun_eur / r.signing_eur : 0,
  }));

  const bySector: OverrunSectorRow[] = sectorRes.results.map((r) => {
    const code = (r.division ?? '').trim();
    return {
      code,
      label: SECTOR_LABELS.get(code) ?? (code ? `Сектор ${code}` : 'Без код'),
      bucket: cpvBucket(code),
      riskEur: r.risk_eur,
      growth: r.signing_eur > 0 ? r.risk_eur / r.signing_eur : 0,
      contracts: r.count,
    };
  });

  return { corpus, rows: mapOverrunRows(rowsRes.results), byAuthority, bySector };
}
