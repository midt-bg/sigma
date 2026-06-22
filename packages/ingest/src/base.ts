// Base EOP plain-JSON adapter helpers. Pure and Worker-safe: no Node APIs.

export type BaseCategory = 'contracts' | 'tenders' | 'annexes';
export type BaseCoercionKind =
  | 'text'
  | 'int'
  | 'real'
  | 'bool'
  | 'date'
  | 'secured_inverse'
  | 'variants_enum';
export type BaseStagingValue = string | number | null;
export type BaseStagingRow = Record<string, BaseStagingValue>;

export interface BaseFieldMapEntry {
  column: string;
  key: string | null;
  kind: BaseCoercionKind;
}

interface BaseCategoryConfig {
  table: 'raw_contracts' | 'raw_tenders' | 'raw_amendments';
  fixed: string[];
  fields: BaseFieldMapEntry[];
  keep: (record: Record<string, unknown>) => boolean;
}

export interface BaseRecordMeta {
  day: string;
  fetchedAt: string;
}

export function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

const MIN_DATA_YEAR = 1990;
const MIN_DATA_DAY = `${MIN_DATA_YEAR}-01-01`;
// Far above any real single BG procurement; only corrupt or misplaced-decimal values are dropped.
export const MAX_PLAUSIBLE_VALUE = 10_000_000_000;

function maxDataYear(): number {
  return new Date().getUTCFullYear() + 1;
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_DATA_YEAR && year <= maxDataYear();
}

function validDateOnly(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function normalizedDateOnly(v: unknown): string | null {
  const s = clean(v);
  if (s === null) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\b)/);
  let day: string | null = null;
  if (iso) day = `${iso[1]!}-${iso[2]!}-${iso[3]!}`;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (!day && m) day = `${m[3]!}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  if (!day) {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    day = new Date(t).toISOString().slice(0, 10);
  }
  return validDateOnly(day) && day >= MIN_DATA_DAY ? day : null;
}

function saneDateCeiling(now: Date): string {
  return `${now.getUTCFullYear() + 50}-12-31`;
}

export function toInt(v: unknown): number | null {
  const s = clean(v);
  if (s === null) return null;
  const compact = s.replace(/\s/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;
  const n = Number(compact);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function toReal(v: unknown): number | null {
  let s = clean(v);
  if (s === null) return null;
  s = s.replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\+?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PLAUSIBLE_VALUE ? n : null;
}

export function toBool(v: unknown): number | null {
  const s = clean(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (['да', 'true', '1', 'yes'].includes(t)) return 1;
  if (['не', 'false', '0', 'no'].includes(t)) return 0;
  return null;
}

export function toISODate(v: unknown, now: Date = new Date()): string | null {
  const day = normalizedDateOnly(v);
  return day !== null && day <= saneDateCeiling(now) ? day : null;
}

export function toEventDate(v: unknown, now: Date = new Date()): string | null {
  return toISODate(v, now);
}

export function toPeriodDate(v: unknown, now: Date = new Date()): string | null {
  return toISODate(v, now);
}

function toSecuredFinancing(v: unknown): number | null {
  const unsecured = toBool(v);
  return unsecured === null ? null : unsecured === 1 ? 0 : 1;
}

function toVariants(v: unknown): number | null {
  const s = clean(v);
  if (s === 'Разрешено') return 1;
  if (s === 'Забранено') return 0;
  return null;
}

export function coerce(kind: BaseCoercionKind, v: unknown): BaseStagingValue {
  if (kind === 'int') return toInt(v);
  if (kind === 'real') return toReal(v);
  if (kind === 'bool') return toBool(v);
  if (kind === 'date') return toISODate(v);
  if (kind === 'secured_inverse') return toSecuredFinancing(v);
  if (kind === 'variants_enum') return toVariants(v);
  return clean(v);
}

const field = (column: string, key: string | null, kind: BaseCoercionKind): BaseFieldMapEntry => ({
  column,
  key,
  kind,
});

const yearOf = (day: string): number | null => {
  const year = Number(day.slice(0, 4));
  return validYear(year) ? year : null;
};

export const BASE_CATEGORIES: Record<BaseCategory, BaseCategoryConfig> = {
  contracts: {
    table: 'raw_contracts',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at', 'needs_enrichment'],
    keep: (record) => clean(record.contractNumber) !== null,
    fields: [
      field('seq_no', null, 'text'),
      field('document_number', 'noticeId', 'text'),
      field('published_at', 'publicationDate', 'date'),
      field('unp', 'uniqueProcurementNumber', 'text'),
      field('tender_ext_id', 'tenderId', 'text'),
      field('procedure_type', 'procedureType', 'text'),
      field('procurement_subject', 'tenderName', 'text'),
      field('cpv_code', 'tenderMainCpv', 'text'),
      field('cpv_description', 'tenderMainCpvDescription', 'text'),
      field('contract_kind', 'typeOfContract', 'text'),
      field('estimated_value', 'estimatedValue', 'real'),
      field('procurement_currency', 'currency', 'text'),
      field('legal_basis', 'legalBasis', 'text'),
      field('award_criteria', 'awardMethod', 'text'),
      field('joint_procurement', 'isJointProcurement', 'bool'),
      field('central_purchasing', 'isCentralPurchasingAuthority', 'bool'),
      field('authority_name', 'buyerName', 'text'),
      field('authority_eik', 'buyerRegistryNumber', 'text'),
      field('authority_type', 'buyerType', 'text'),
      field('main_activity', 'buyerMainActivity', 'text'),
      field('notice_type', 'noticeType', 'text'),
      field('lot_id', 'lotIdentifier', 'text'),
      field('contract_number', 'contractNumber', 'text'),
      field('contract_date', 'contractDate', 'date'),
      field('signing_value', 'contractValue', 'real'),
      field('currency', 'contractCurrency', 'text'),
      field('contract_subject', 'contractSubject', 'text'),
      field('awarded_to_group', 'awardedToGroup', 'bool'),
      field('contractor_eik', 'supplierRegisterNumber', 'text'),
      field('contractor_name', 'supplierName', 'text'),
      field('contractor_country', 'supplierNationality', 'text'),
      field('winner_owner_nationality', null, 'text'),
      field('winner_size', 'supplierCompanySizeCode', 'text'),
      field('has_subcontractor', 'hasSubcontractors', 'bool'),
      field('subcontractor_name', 'subcontractorName', 'text'),
      field('subcontractor_eik', 'subcontractorRegistryNumber', 'text'),
      field('subcontract_share', 'subcontractingPercent', 'text'),
      field('subcontract_value', 'subcontractingAmount', 'real'),
      field('eu_funded', 'isEuFunded', 'bool'),
      field('eu_programme', 'europeanProgram', 'text'),
      field('framework_notice', 'isFrameworkAgreement', 'bool'),
      field('framework_contract', 'frameworkAgreementContract', 'bool'),
      field('related_to', 'linkedTenders', 'text'),
      field('dps_contract', 'contractUnderQs', 'bool'),
      field('accelerated', 'isAcceleratedProcedure', 'bool'),
      field('eauction', 'hasAuctionQuotationMethod', 'bool'),
      field('strategic', 'isStrategicTender', 'bool'),
      field('outside_zop', 'isExceptionContract', 'bool'),
      field('exemption_legal_basis', 'directAwardJustification', 'text'),
      field('bids_received', 'offersCount', 'int'),
      field('bids_sme', 'smeOffersCount', 'int'),
      field('bids_rejected', 'disqualifiedOffersCount', 'int'),
      field('bids_non_eea', 'noEeaOffersCount', 'int'),
      field('duration_days', 'contractPeriod', 'int'),
      field('non_award', 'noAwarding', 'bool'),
      field('correction_number', null, 'text'),
      field('ted_link', 'linkToOjEu', 'text'),
    ],
  },
  tenders: {
    table: 'raw_tenders',
    fixed: ['source', 'dataset_year', 'fetched_at'],
    keep: () => true,
    fields: [
      field('seq_no', null, 'text'),
      field('document_number', 'noticeId', 'text'),
      field('published_at', 'publicationDate', 'date'),
      field('unp', 'uniqueProcurementNumber', 'text'),
      field('tender_id', 'tenderId', 'text'),
      field('procedure_type', 'procedureType', 'text'),
      field('procurement_subject', 'subject', 'text'),
      field('cpv_code', 'mainCpvCode', 'text'),
      field('cpv_description', 'mainCpvDescription', 'text'),
      field('contract_kind', 'typeOfContract', 'text'),
      field('estimated_value', 'estimatedValue', 'real'),
      field('currency', 'currency', 'text'),
      field('legal_basis', 'legalBasis', 'text'),
      field('award_criteria', 'awardMethod', 'text'),
      field('joint_procurement', 'hasJointProcurement', 'bool'),
      field('central_purchasing', 'isCentralPurchasingAuthority', 'bool'),
      field('authority_name', 'buyerName', 'text'),
      field('authority_eik', 'buyerRegistryNumber', 'text'),
      field('authority_type', 'buyerType', 'text'),
      field('main_activity', 'buyerMainActivity', 'text'),
      field('deadline', 'submissionDeadline', 'text'),
      field('notice_type', 'noticeType', 'text'),
      field('lot_id', 'lotIdentifier', 'text'),
      field('eu_funded', 'isEuFunded', 'bool'),
      field('eu_programme', 'europeanProgram', 'text'),
      field('secured_financing', 'hasUnsecuredFunding', 'secured_inverse'),
      field('framework_notice', 'isFrameworkAgreement', 'bool'),
      field('dps_notice', 'isDpsProcedure', 'bool'),
      field('accelerated', 'isAcceleratedProcedure', 'bool'),
      field('eauction', 'hasElectronicAuction', 'bool'),
      field('strategic', 'isStrategicProcurement', 'bool'),
      field('green', 'isGreenProcurement', 'bool'),
      field('social', 'isSocialProcurement', 'bool'),
      field('innovation', 'isInnovationProcurement', 'bool'),
      field('options', 'hasOptions', 'bool'),
      field('renewable', 'hasRenewal', 'bool'),
      field('reserved', 'isReservedProcurement', 'bool'),
      field('variants', 'hasVariants', 'variants_enum'),
      field('num_lots', 'lotsCount', 'int'),
      field('place_of_performance', 'executionPlaceNuts', 'text'),
      field('lot_name', 'lotTenderName', 'text'),
      field('duration', 'tenderDuration', 'text'),
      field('duration_unit', 'tenderDurationUnit', 'text'),
      field('start_date', 'tenderStartDate', 'date'),
      field('end_date', 'tenderEndDate', 'date'),
      field('einvoicing', 'electronicInvoicing', 'bool'),
      field('epayment', 'electronicPayment', 'bool'),
      field('eordering', 'electronicOrdering', 'bool'),
      field('corrections_count', 'changeNoticeCount', 'int'),
      field('cancelled', 'isCancelled', 'bool'),
      field('correction_number', null, 'text'),
      field('ted_link', 'linkToOjEu', 'text'),
    ],
  },
  annexes: {
    table: 'raw_amendments',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at'],
    keep: (record) => clean(record.contractNumber) !== null,
    fields: [
      field('seq_no', null, 'text'),
      field('document_number', 'noticeId', 'text'),
      field('published_at', 'publicationDate', 'date'),
      field('unp', 'uniqueProcurementNumber', 'text'),
      field('tender_ext_id', 'tenderId', 'text'),
      field('procedure_type', 'procedureType', 'text'),
      field('procurement_subject', 'tenderName', 'text'),
      field('cpv_code', 'tenderMainCpv', 'text'),
      field('cpv_description', 'tenderMainCpvDescription', 'text'),
      field('contract_kind', 'typeOfContract', 'text'),
      field('authority_name', 'buyerName', 'text'),
      field('authority_eik', 'buyerRegistryNumber', 'text'),
      field('authority_type', 'buyerType', 'text'),
      field('main_activity', 'buyerMainActivity', 'text'),
      field('lot_id', 'lotIdentifier', 'text'),
      field('contract_number', 'contractNumber', 'text'),
      field('contract_date', 'contractDate', 'date'),
      field('value_before', 'lastContractValue', 'real'),
      field('value_after', 'currentContractValue', 'real'),
      field('value_delta', 'contractValueDifference', 'real'),
      field('currency', 'contractCurrency', 'text'),
      field('contract_subject', 'contractSubject', 'text'),
      field('awarded_to_group', 'awardedToGroup', 'bool'),
      field('contractor_eik', 'supplierRegisterNumber', 'text'),
      field('contractor_name', 'supplierName', 'text'),
      field('contractor_country', 'supplierNationality', 'text'),
      field('winner_owner_nationality', null, 'text'),
      field('winner_size', 'supplierCompanySizeCode', 'text'),
      field('eu_funded', 'isEuFunded', 'bool'),
      field('eu_programme', 'europeanProgram', 'text'),
      field('description', 'changeDescription', 'text'),
      field('reason', 'changeReason', 'text'),
      field('circumstances', 'changeReasonDescription', 'text'),
      field('outside_zop', 'isExceptionContract', 'bool'),
      field('exemption_legal_basis', 'directAwardJustification', 'text'),
      field('correction_number', null, 'text'),
      field('ted_link', 'linkToOjEu', 'text'),
    ],
  },
};

function fixedValues(cat: BaseCategory, meta: BaseRecordMeta): BaseStagingRow {
  if (cat === 'contracts') {
    return {
      source: `eop:contracts:${meta.day}`,
      dataset_year: yearOf(meta.day),
      dataset_variant: 'eop',
      fetched_at: meta.fetchedAt,
      needs_enrichment: 0,
    };
  }
  if (cat === 'tenders') {
    return {
      source: `eop:tenders:${meta.day}`,
      dataset_year: yearOf(meta.day),
      fetched_at: meta.fetchedAt,
    };
  }
  return {
    source: `eop:annexes:${meta.day}`,
    dataset_year: yearOf(meta.day),
    dataset_variant: 'eop',
    fetched_at: meta.fetchedAt,
  };
}

export function baseInsertColumns(cat: BaseCategory): string[] {
  const cfg = BASE_CATEGORIES[cat];
  return [...cfg.fixed, ...cfg.fields.map((f) => f.column)];
}

function baseColumnKind(cat: BaseCategory, column: string): BaseCoercionKind {
  if (column === 'dataset_year' || column === 'needs_enrichment') return 'int';
  const match = BASE_CATEGORIES[cat].fields.find((f) => f.column === column);
  return match?.kind ?? 'text';
}

export function mapBaseRecord(
  cat: BaseCategory,
  record: Record<string, unknown>,
  meta: BaseRecordMeta,
): BaseStagingRow | null {
  const cfg = BASE_CATEGORIES[cat];
  if (!cfg.keep(record)) return null;
  const row: BaseStagingRow = fixedValues(cat, meta);
  for (const f of cfg.fields) row[f.column] = f.key === null ? null : coerce(f.kind, record[f.key]);
  return row;
}

// Hard ceiling on a single text literal's character length. EOP/registry text fields
// (subjects, descriptions, names) are well under this; anything larger is corrupt or
// hostile and is truncated rather than passed to sqlite (avoids SQLITE_TOOBIG / abuse of
// the offline `.sql` files). Chosen well below SQLite's default 1e9-byte string limit.
export const MAX_SQL_TEXT_LEN = 1_000_000;

// Strip NUL and every C0 (\x00-\x1F) and C1 (\x7F-\x9F) control character. These have no
// place in a one-line SQL literal and DEL/C1 in particular can corrupt the generated file
// or confuse downstream tooling. Printable text (incl. all Cyrillic / Unicode) is untouched.
const SQL_CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Assert that `literal` is a well-formed single-quoted SQL string literal: it starts and
 * ends with a single quote and contains no unescaped (odd-run) single quote. Throws on
 * violation so a broken escape can never silently reach sqlite.
 */
export function assertWellFormedSqlLiteral(literal: string): void {
  if (literal.length < 2 || literal[0] !== "'" || literal[literal.length - 1] !== "'") {
    throw new Error('escapeSqlText produced a literal not delimited by single quotes');
  }
  // Inner content must contain only paired single quotes (each `'` doubled as `''`).
  const inner = literal.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "'") continue;
    if (inner[i + 1] !== "'") {
      throw new Error('escapeSqlText produced a literal with an unescaped single quote');
    }
    i += 1; // skip the paired quote
  }
}

/**
 * Build a safely-escaped single-quoted SQL string literal for OFFLINE `.sql` generation
 * (executed via `wrangler d1 execute --file` / `sqlite3`, never from an HTTP request).
 *
 * Hardening invariants:
 *  - input is truncated to {@link MAX_SQL_TEXT_LEN} characters before escaping;
 *  - all NUL / C0 / C1 control chars are removed;
 *  - every single quote is doubled;
 *  - the result is asserted to be a well-formed quoted literal (delimited by single
 *    quotes with no unescaped single quote inside) and throws otherwise — a cheap
 *    invariant that catches future escaping regressions before they reach sqlite.
 */
export function escapeSqlText(value: string): string {
  let truncated = value;
  if (value.length > MAX_SQL_TEXT_LEN) {
    truncated = value.slice(0, MAX_SQL_TEXT_LEN);
    // A code-unit slice can split a surrogate pair; drop a trailing lone high surrogate so the cut
    // text stays well-formed UTF-16 (otherwise the UTF-8 file write silently yields U+FFFD).
    const last = truncated.charCodeAt(truncated.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
  }
  const escaped = truncated.replace(SQL_CONTROL_CHARS, '').replace(/'/g, "''");
  const literal = `'${escaped}'`;
  assertWellFormedSqlLiteral(literal);
  return literal;
}

export function baseSqlLiteral(
  cat: BaseCategory,
  column: string,
  value: BaseStagingValue | undefined,
): string {
  if (value === null || value === undefined) return 'NULL';
  const kind = baseColumnKind(cat, column);
  if (['int', 'real', 'bool', 'secured_inverse', 'variants_enum'].includes(kind)) {
    return String(value);
  }
  return escapeSqlText(String(value));
}

export const BASE_CONTRACT_COLS = baseInsertColumns('contracts');
export const BASE_TENDER_COLS = baseInsertColumns('tenders');
export const BASE_AMENDMENT_COLS = baseInsertColumns('annexes');
