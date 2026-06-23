// ═════════════════════════════════════════════════════════════════════════════════════════════
// Explorer DTOs (v1 public explorer) — the typed shapes apps/web loaders return. Monetary values are
// plain EUR numbers (the corpus is converted to amount_eur upstream); `null` means genuinely absent (the
// UI renders „—" or a „данните се проверяват" note), never a fabricated value.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type EntityKind = 'company' | 'consortium';
export type OwnershipKind = 'state' | 'municipal' | 'mixed';

/** One keyset page. Total is from a rollup or a cached COUNT; cursors drive Prev/Next (no deep
 *  OFFSET page-jumps — see docs/v1-implementation-plan.md "Pagination"). */
export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
  prevCursor: string | null;
}

/** A CPV-division sector reference (label resolved via @sigma/config). */
export interface SectorRef {
  code: string;
  label: string;
  short: string;
}

/** A procedure-group slice for the „Как купува / Как печели" StackedBar. */
export interface ProcedureSlice {
  key: string;
  label: string;
  color: string;
  competitive: boolean | null;
  contracts: number;
  valueEur: number;
  sharePct: number; // 0–1 share of the entity's value
}

/** A facet option (filter checkbox) with its result count. */
export interface FacetCount {
  value: string;
  label: string;
  count: number;
}

// ── Home ────────────────────────────────────────────────────────────────────────────────────────

export interface HomeTotals {
  contracts: number;
  valueEur: number;
  authorities: number;
  bidders: number;
  suspect: number;
  asOf: string | null; // data current-as-of date
  refreshedAt: string;
}

export interface HomeData {
  totals: HomeTotals;
  topCompanies: CompanyListItem[];
  topMinistries: AuthorityListItem[];
  topMunicipalities: AuthorityListItem[];
  /** Single-offer (bids_received = 1) contracts for the homepage section. */
  recentSingleOffer: ContractListItem[];
  topSingleOffer: ContractListItem[];
  /** Aggregate value/count of single-offer contracts — for the homepage portion bar. */
  singleOffer: { valueEur: number; contracts: number };
}

// ── Companies ─────────────────────────────────────────────────────────────────────────────────

export interface CompanyListItem {
  slug: string; // /companies/:slug
  name: string; // source name (verbatim)
  displayName: string; // entityName() — consortium collapsed to „first и др."
  kind: EntityKind;
  isConsortium: boolean;
  eik: string | null;
  eikValid: boolean;
  hasEik: boolean;
  ownershipKind: OwnershipKind | null;
  settlement: string | null;
  sector: SectorRef | null; // primary sector
  wonEur: number;
  contracts: number;
  authorities: number;
}

export interface AuthorityShare {
  slug: string;
  name: string;
  paidEur: number;
  contracts: number;
  sharePct: number; // 0–1 of the company's total won
}

/** Distribution of won tenders by number of bids received (`contracts.bids_received`, ~90% coverage). */
export interface BidDistribution {
  one: number;
  two: number;
  three: number;
  fourPlus: number;
  unknown: number;
}

/** One member of a consortium, as derived from the upstream `contractor_name` string. v1 has no
 *  per-member ЕИК (the Trade Register backfill that would link names → company profiles is parked,
 *  see docs/core-scope.md § Owner/Лице layer), so `eik` and `resolvedSlug` are always null today —
 *  the fields are here so the schema doesn't break when TR resolution lands. */
export interface ConsortiumParticipant {
  name: string;
  eik: string | null;
  resolvedSlug: string | null;
}

export interface CompanyDetail {
  slug: string;
  name: string;
  displayName: string;
  kind: EntityKind;
  isConsortium: boolean;
  eik: string | null;
  eikValid: boolean;
  hasEik: boolean;
  ownershipKind: OwnershipKind | null;
  settlement: string | null;
  region: string | null;
  legalForm: string | null;
  wonEur: number;
  contracts: number;
  authorities: number;
  sector: SectorRef | null;
  sectorSharePct: number | null; // primary sector's share of won €
  euSharePct: number; // share of won € on EU-funded contracts
  avgBids: number | null;
  periodFirst: string | null;
  periodLast: string | null;
  suspect: number; // own contracts excluded from sums (suspect value)
  topAuthorities: AuthorityShare[];
  moreAuthorities: number;
  procedureMix: ProcedureSlice[];
  bids: BidDistribution;
  /** Highest-value contracts (listContracts sort='value-desc', amount_eur DESC) — „Най-големи по стойност". */
  topContracts: ContractListItem[];
  /** Most-recent contracts (listContracts sort='date-desc', signed_at DESC) — the „Най-нови" tab. */
  recentContracts: ContractListItem[];
  /** Members parsed from the consortium's contractor_name string. Empty for plain companies and
   *  for consortia whose source row carries only a single name with the ДЗЗД/ОБЕДИНЕНИЕ keyword. */
  participants: ConsortiumParticipant[];
  /** Verbatim text when the source row is a free-text dump ("Съдружници … са следните лица: 1. …
   *  40 %; 2. … 60 %") rather than a clean `;`-list. Rare (~4 rows in production); rendered as a
   *  quotable block so the original detail survives. */
  membershipNote: string | null;
}

// ── Authorities ─────────────────────────────────────────────────────────────────────────────────

export interface AuthorityListItem {
  slug: string; // /authorities/:eik
  name: string;
  typeGroup: string | null;
  typeLabel: string | null; // friendly bucket label
  settlement: string | null;
  spentEur: number;
  contracts: number;
  avgEur: number;
}

export interface CompanyShare {
  slug: string;
  name: string;
  displayName: string;
  kind: EntityKind;
  wonEur: number;
  contracts: number;
  sharePct: number; // 0–1 of the authority's total spent
}

export interface SectorSpend {
  code: string;
  label: string;
  short: string;
  valueEur: number;
  sharePct: number;
}

export interface AuthorityDetail {
  slug: string;
  name: string;
  eik: string;
  typeGroup: string | null;
  typeLabel: string | null;
  settlement: string | null;
  region: string | null;
  spentEur: number;
  contracts: number;
  suppliers: number;
  avgEur: number;
  euSharePct: number;
  avgBids: number | null;
  periodFirst: string | null;
  periodLast: string | null;
  suspect: number;
  topContractors: CompanyShare[];
  moreContractors: number;
  sectors: SectorSpend[];
  sectorsOther: SectorSpend | null; // „… още CPV категории" rollup of the long tail
  procedureMix: ProcedureSlice[];
  /** Most-recent contracts (listContracts sort='date-desc', signed_at DESC) — the „Най-нови" tab. */
  recentContracts: ContractListItem[];
  /** Highest-value contracts (listContracts sort='value-desc', amount_eur DESC) — „Най-големи по стойност". */
  topContracts: ContractListItem[];
}

// ── Contracts ─────────────────────────────────────────────────────────────────────────────────

export interface ContractListItem {
  id: string; // /contracts/:id
  subject: string;
  unp: string;
  sectorCode: string | null;
  euFunded: boolean;
  isConsortium: boolean;
  authoritySlug: string;
  authorityName: string;
  bidderSlug: string;
  bidderName: string;
  bidderDisplayName: string;
  bidderKind: EntityKind;
  procedureLabel: string;
  signedAt: string | null;
  bidsReceived: number | null;
  valueEur: number | null; // null = suspect / unconvertible → render the проверяват note
}

export interface ContractParty {
  slug: string;
  name: string;
  displayName: string;
  kind?: EntityKind;
  typeLabel: string | null;
  settlement: string | null;
  eik: string | null;
  sector: SectorRef | null;
  totalContracts: number;
  totalEur: number;
}

export interface ContractValueTimeline {
  estimatedEur: number | null; // lot forecast when available; otherwise procurement-level forecast
  procedureEstimatedEur: number | null; // procurement-level forecast (whole prepiska), for context
  signingEur: number | null;
  currentEur: number | null;
  deltaPct: number | null; // (current − signing) / signing, when both present
  suspect: boolean; // value_/annex_suspect/review → render with an unverified-value label
}

export interface ContractLotRow {
  lotLabel: string;
  subject: string;
  contractId: string | null; // link when this lot has its own awarded contract
  contractorSlug: string | null;
  contractorName: string | null;
  estimatedEur: number | null;
  signingEur: number | null;
  isCurrent: boolean; // the lot this contract page is for
}

export interface ContractLots {
  unp: string;
  numLots: number | null;
  rows: ContractLotRow[];
  estimatedTotalEur: number | null;
  signedTotalEur: number | null;
}

export interface ContractDetail {
  id: string;
  subject: string;
  unp: string;
  contractNumber: string | null;
  documentNumber: string | null;
  /** Raw EOP numeric tenderId of the parent procedure. The public ЦАИС ЕОП portal keys its documents
   *  page on this id (https://app.eop.bg/today/<eopTenderId>) — it is NOT the noticeId/documentNumber.
   *  Null when the source carried no tenderId (then the documents deep-link is hidden). */
  eopTenderId: string | null;
  lotLabel: string | null;
  signedAt: string | null;
  publishedAt: string | null;
  dateSuspect: boolean;
  startDate: string | null;
  endDate: string | null;
  contractKind: string | null;
  cpvCode: string | null;
  cpvDescription: string | null;
  sector: SectorRef | null;
  procedureLabel: string;
  /** Gross count of submitted offers (per AOP „Брой оферти") — includes rejected ones. The valid
   *  count is `bidsReceived - bidsRejected` when both are known; the renderer surfaces that as
   *  „N допуснати" in the sub-line alongside the headline number. */
  bidsReceived: number | null;
  /** „Брой отстранени оферти" — disqualified offers. Almost always populated when bidsReceived is
   *  (≈100% of rows), but the value is 0 on most contracts (only ~2 % had any rejection). */
  bidsRejected: number | null;
  /** „Брой оферти от МСП" — offers from small/medium enterprises. ≈86 % populated; on ~54 % of
   *  contracts there was at least one SME bidder. */
  bidsSme: number | null;
  /** „Брой оферти извън ЕИП" — offers from outside the European Economic Area. Populated on ≈30 %
   *  of rows, but the value is 0 on virtually all of them (only 82 contracts had any). */
  bidsNonEea: number | null;
  euFunded: boolean | null;
  euProgramme: string | null;
  durationDays: number | null;
  value: ContractValueTimeline;
  /** When this contract is one of several awards under the same procedure (more awards than lots — a
   *  framework agreement / dynamic purchasing system call-off), this is the total number of awarded
   *  contracts under the parent tender. Null for a normal single/per-lot award. The procedure-level
   *  estimate then represents the whole framework ceiling, not this individual call-off. */
  frameworkAwards: number | null;
  authority: ContractParty;
  bidder: ContractParty;
  lots: ContractLots | null;
  /** Declared subcontractor from the АОП feed ("Подизпълнител"), sparse (~0.8% of contracts). */
  subcontractor: { name: string; eik: string | null; valueEur: number | null } | null;
}

/** The machine-readable contract record served at `/contracts/:id.json`. */
export interface ContractRecord extends ContractDetail {
  sourceNames: { authority: string; bidder: string }; // verbatim source names
}

// ── Flows ───────────────────────────────────────────────────────────────────────────────────────

export interface FlowPair {
  rank: number;
  authoritySlug: string;
  authorityName: string;
  bidderSlug: string;
  bidderName: string;
  bidderDisplayName: string;
  bidderKind: EntityKind;
  wonEur: number;
  contracts: number;
}

/** A Sankey node, positioned by the loader (the mock ships zero chart JS; geometry is server-side). */
export interface SankeyNode {
  label: string;
  valueEur: number;
  side: 'authority' | 'company';
  x: number;
  y: number;
  width: number;
  height: number;
  labelY: number;
  href?: string; // drill-down target (/authorities/:slug | /companies/:slug)
}

export interface SankeyRibbon {
  d: string; // SVG path
  title: string;
  fromName: string;
  toName: string;
  valueEur: number;
  contracts: number;
}

export interface SankeyLayout {
  viewBox: string;
  width: number;
  height: number;
  nodes: SankeyNode[];
  ribbons: SankeyRibbon[];
}

export interface FlowsData {
  pairs: FlowPair[];
  sankey: SankeyLayout;
  sectors: SectorRef[]; // options for the sector select
  scope: {
    sector: string | null;
    year: number | null;
    funding: 'all' | 'eu' | 'national';
    top: number;
  };
}

// ── Network (relationship graph) ────────────────────────────────────────────────────────────────
// Ego network around one entity for the /network graph: the centre plus its direct counterparties
// (hop 1) and their top other counterparty (hop 2), to reveal shared suppliers / authorities. Built
// from the flow_pairs rollup; this is a focused neighbourhood, not the full graph.

export interface NetworkNode {
  id: string; // domain id ('auth:ЕИК' | 'eik:ЕИК' | 'name:...')
  kind: 'authority' | 'company';
  label: string;
  slug: string; // /authorities/:slug | /companies/:slug
  valueEur: number; // weight = sum of incident edge values in this view
  hop: number; // 0 centre, 1 direct, 2 second ring
}

export interface NetworkEdge {
  from: string; // node id
  to: string; // node id
  valueEur: number;
  contracts: number;
}

export interface NetworkCenterOption {
  kind: 'authority' | 'company';
  label: string;
  value: string; // ?center= token, e.g. 'a:000695089' | 'c:131468980'
}

export interface NetworkData {
  center: {
    id: string;
    kind: 'authority' | 'company';
    label: string;
    slug: string;
    valueEur: number;
  } | null;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  centerOptions: { authorities: NetworkCenterOption[]; companies: NetworkCenterOption[] };
}

// ── Trend (spending over time) ──────────────────────────────────────────────────────────────────
// Procurement spend by period for the /trends chart. Contracts without a usable signing date are
// excluded from the series and reported as coverage, never silently dropped.

export interface TrendPoint {
  period: string; // 'YYYY-MM' (month granularity) or 'YYYY' (year)
  valueEur: number;
  contracts: number;
  partial: boolean; // the final period (the as_of period) is still being filled; rendered dashed
}

export interface TrendYear {
  year: string;
  valueEur: number;
  contracts: number;
  yoyPct: number | null; // change vs the previous year (0-based ratio); null for the first year, a zero previous year, or the partial final year
  partial: boolean; // the as_of year, still incomplete; YoY is suppressed and it is marked in the UI
}

export interface TrendData {
  granularity: 'month' | 'year';
  points: TrendPoint[]; // continuous and zero-filled, sorted by period
  years: TrendYear[]; // per-year summary with year-over-year change
  sectors: SectorRef[]; // options for the sector select
  totalValueEur: number;
  coverage: { dated: number; total: number; pct: number }; // contracts with a usable signing date
  scope: {
    sector: string | null;
    funding: 'all' | 'eu' | 'national';
    granularity: 'month' | 'year';
  };
}

// ── Regions (map) ─────────────────────────────────────────────────────────────────────────────────
// Spend per Bulgarian region (NUTS3) for the /map choropleth. Region is known for ~half of
// authorities, so the unattributed bucket and coverage are first-class, never hidden.

export interface RegionSpend {
  nuts3: string; // joins the map geometry (apps/web/app/lib/bg-region-geometry.ts) and @sigma/config BG_REGIONS
  name: string;
  nuts2: string;
  nuts2Name: string;
  valueEur: number;
  contracts: number;
  authorities: number;
}

export interface MacroRegionSpend {
  nuts2: string;
  name: string;
  valueEur: number;
  contracts: number;
}

export interface RegionalSpending {
  regions: RegionSpend[]; // all 28 regions, zero-filled when absent, sorted by value desc
  macroRegions: MacroRegionSpend[]; // the 6 NUTS2 planning regions
  sectors: SectorRef[]; // options for the sector select
  unattributed: { valueEur: number; contracts: number; authorities: number }; // region unknown
  coverage: { withRegion: number; total: number; pct: number }; // share of authorities with a region
  totalValueEur: number; // sum over the 28 known regions
  scope: { sector: string | null; year: number | null; funding: 'all' | 'eu' | 'national' };
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

export interface SearchHit {
  kind: 'authority' | 'company' | 'contract';
  slug: string;
  href: string;
  title: string;
  ident: string | null; // ЕИК / УНП
  isConsortium?: boolean;
  hasEik?: boolean;
  ownershipKind?: OwnershipKind | null;
  memberCount?: number | null;
  subtitle: string | null;
  amountEur: number | null;
  amountLabel: string; // „общо похарчено" / „общо спечелено" / „стойност"
}

export interface SearchGroup {
  kind: 'authority' | 'company' | 'contract';
  label: string;
  total: number;
  hits: SearchHit[];
  moreHref: string | null; // „Виж всички …" link when there are more than shown
}

export interface SearchResults {
  query: string;
  groups: SearchGroup[];
  empty: boolean;
}
