import type { Money, RiskBand } from '@sigma/shared';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tender DTOs — consumed by apps/api (the parked public JSON API). Kept as-is.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface TenderSummary {
  id: string;
  title: string;
  authorityName: string;
  estimatedValue: Money | null;
  status: string;
  riskScore: number | null;
  riskBand: RiskBand | null;
  publishedAt: string | null;
  sector: string | null; // curated short name or CPV-division label (via @sigma/config)
  sectorCode: string | null; // 2-digit CPV division
}

export interface TenderDetail extends TenderSummary {
  cpvCode: string | null;
  procedureType: string;
  deadlineAt: string | null;
  signals: Record<string, number> | null;
}

export interface SearchTendersQuery {
  q?: string;
  status?: string;
  minRisk?: number;
  limit?: number;
  cursor?: string;
}

export interface SearchTendersResponse {
  results: TenderSummary[];
  cursor: string | null;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface SectorFacet {
  code: string; // 2-digit CPV division
  label: string;
  curated: boolean; // featured sector (also drives the price index)
  contracts: number;
  valueEur: number;
}

export interface SectorsResponse {
  sectors: SectorFacet[];
}

export const API_ROUTES = {
  searchTenders: '/api/tenders',
  tenderDetail: (id: string) => `/api/tenders/${id}`,
  riskScore: (id: string) => `/api/tenders/${id}/risk`,
  sectors: '/api/sectors',
  openData: '/api/open-data/tenders.json',
} as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Explorer DTOs (v1 public explorer) — the typed shapes apps/web loaders return. Money is plain
// EUR numbers (the corpus is converted to amount_eur upstream); `null` means genuinely absent (the
// UI renders „—" or a „данните се преглеждат" note), never a fabricated value.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export type EntityKind = 'company' | 'consortium';

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
}

// ── Companies ─────────────────────────────────────────────────────────────────────────────────

export interface CompanyListItem {
  slug: string; // /companies/:slug
  name: string; // source name (verbatim)
  displayName: string; // entityName() — consortium collapsed to „first и др."
  kind: EntityKind;
  eik: string | null;
  eikValid: boolean;
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

export interface CompanyDetail {
  slug: string;
  name: string;
  displayName: string;
  kind: EntityKind;
  eik: string | null;
  eikValid: boolean;
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
  topContracts: ContractListItem[];
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
  recentContracts: ContractListItem[];
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
  valueEur: number | null; // null = suspect / unconvertible → render the преглеждат note
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
  estimatedEur: number | null; // procurement-level forecast (whole prepiska)
  signingEur: number | null;
  currentEur: number | null;
  deltaPct: number | null; // (current − signing) / signing, when both present
  suspect: boolean; // value_/annex_suspect → figures suppressed
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
  lotLabel: string | null;
  signedAt: string | null;
  publishedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  contractKind: string | null;
  cpvCode: string | null;
  cpvDescription: string | null;
  sector: SectorRef | null;
  procedureLabel: string;
  bidsReceived: number | null;
  euFunded: boolean | null;
  euProgramme: string | null;
  durationDays: number | null;
  value: ContractValueTimeline;
  authority: ContractParty;
  bidder: ContractParty;
  lots: ContractLots | null;
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
  scope: { sector: string | null; year: number | null; funding: 'all' | 'eu' | 'national'; top: number };
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────────

export interface SearchHit {
  kind: 'authority' | 'company' | 'contract';
  slug: string;
  href: string;
  title: string;
  ident: string | null; // ЕИК / УНП
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
