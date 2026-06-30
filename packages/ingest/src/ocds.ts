// OCDS adapter helpers for the procurement ETL. The pure release flatteners here are the single
// source of truth used by both the Worker-side ingest package and the CLI loaders.

const KIND_CATEGORY: Record<string, string> = {
  goods: 'Доставки',
  services: 'Услуги',
  works: 'Строителство',
};

const MS_PER_DAY = 86_400_000;
const MIN_DATA_YEAR = 1990;
const MIN_DATA_DAY = `${MIN_DATA_YEAR}-01-01`;

function maxDataYear(): number {
  return new Date().getUTCFullYear() + 1;
}

function validYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_DATA_YEAR && year <= maxDataYear();
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
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

function toISODate(v: unknown, now: Date = new Date()): string | null {
  const day = normalizedDateOnly(v);
  return day !== null && day <= saneDateCeiling(now) ? day : null;
}

function toEventDate(v: unknown, now: Date = new Date()): string | null {
  return toISODate(v, now);
}

const dateOnly = (s: unknown): string | null => toEventDate(s);
const finiteNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const boundedYear = (v: unknown): number | null => {
  const year = Number(v);
  return validYear(year) ? year : null;
};
const isoCurrency = (v: unknown): string | null => {
  const code = String(v ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

function validateDay(day: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) {
    throw new Error(`${label} is not a valid date: ${day}`);
  }
}

function subtractDays(day: string, days: number): string {
  validateDay(day, 'day');
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(0, Math.floor(days)));
  return d.toISOString().slice(0, 10);
}

// Minimal shapes of the OCDS fields we read (the feed carries far more; keep it loose on purpose).
export interface OcdsRelease {
  ocid?: string;
  id?: string;
  date?: string;
  tag?: string[];
  parties?: Array<{
    id?: string;
    name?: string;
    identifier?: { id?: string; scheme?: string };
    roles?: string[];
    address?: {
      streetAddress?: string;
      locality?: string;
      postalCode?: string;
      region?: string;
      countryName?: string;
    };
    contactPoint?: { name?: string; email?: string; telephone?: string };
  }>;
  buyer?: { id?: string; name?: string };
  tender?: {
    id?: string;
    title?: string;
    value?: { amount?: unknown; currency?: unknown };
    mainProcurementCategory?: string;
    procurementMethod?: string;
    procurementMethodDetails?: string;
    items?: Array<{ classification?: { id?: string; scheme?: string } }>;
    lots?: Array<{ id?: string; title?: string; value?: { amount?: unknown; currency?: unknown } }>;
  };
  awards?: Array<{
    id?: string;
    title?: string;
    suppliers?: Array<{ id?: string; name?: string; identifier?: { id?: string } }>;
  }>;
  bids?: { statistics?: Array<{ measure?: string; value?: unknown }> };
  contracts?: Array<{
    id?: string;
    awardID?: string;
    title?: string;
    dateSigned?: string;
    value?: { amount?: unknown; currency?: unknown };
    amendments?: Array<{ description?: string; rationale?: string }>;
  }>;
}

export interface OcdsPackage {
  publishedDate?: string;
  releases?: OcdsRelease[];
}

export interface OcdsMeta {
  source: string; // e.g. 'ocds:2026-05-01'
  datasetUri: string | null;
  resourceUri: string | null;
  year: number | null;
  fetchedAt: string;
  publishedDate?: string;
}

export interface ContractStagingRow {
  source: string;
  dataset_uri: string | null;
  resource_uri: string | null;
  dataset_year: number | null;
  dataset_variant: string;
  fetched_at: string;
  seq_no: string | null;
  document_number: string | null;
  contract_number: string | null;
  contract_date: string | null;
  published_at: string | null;
  unp: string | null;
  authority_eik: string | null;
  authority_name: string | null;
  procurement_subject: string | null;
  contract_kind: string | null;
  eu_funded: number | null;
  bids_received: number | null;
  contract_subject: string | null;
  contractor_eik: string | null;
  contractor_name: string | null;
  signing_value: number | null;
  currency: string | null;
  vat: string | null;
  sme: string | null;
  procedure_type: string | null;
  cpv_code: string | null;
  estimated_value: number | null;
  current_value: number | null;
  needs_enrichment: number;
}

export interface AmendmentStagingRow {
  source: string;
  dataset_uri: string | null;
  resource_uri: string | null;
  dataset_year: number | null;
  dataset_variant: string;
  fetched_at: string;
  seq_no: string | null;
  document_number: string | null;
  contract_number: string | null;
  contract_date: string | null;
  published_at: string | null;
  unp: string | null;
  authority_eik: string | null;
  authority_name: string | null;
  procurement_subject: string | null;
  contract_kind: string | null;
  eu_funded: number | null;
  contract_subject: string | null;
  contractor_eik: string | null;
  contractor_name: string | null;
  value_before: number | null;
  value_after: number | null;
  value_delta: number | null;
  currency: string | null;
  description: string | null;
  reason: string | null;
  circumstances: string | null;
  sme: string | null;
}

export interface PartyStagingRow {
  source: string;
  dataset_uri: string | null;
  resource_uri: string | null;
  fetched_at: string;
  ocid: string | null;
  party_id: string | null;
  eik: string | null;
  scheme: string | null;
  name: string | null;
  roles: string | null;
  street_address: string | null;
  locality: string | null;
  postal_code: string | null;
  region_nuts: string | null;
  country: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface LotStagingRow {
  source: string;
  dataset_uri: string | null;
  resource_uri: string | null;
  fetched_at: string;
  ocid: string | null;
  tender_id: string | null;
  lot_id: string | null;
  title: string | null;
  value_amount: number | null;
  value_currency: string | null;
}

function metaBase(meta: OcdsMeta) {
  return {
    source: meta.source,
    dataset_uri: meta.datasetUri,
    resource_uri: meta.resourceUri,
    fetched_at: meta.fetchedAt,
  };
}

function relContext(rel: OcdsRelease, meta: OcdsMeta) {
  const party: Record<string, { eik: string | null; name: string | null }> = {};
  for (const p of rel.parties ?? []) {
    if (p.id) party[p.id] = { eik: p.identifier?.id ?? null, name: p.name ?? null };
  }
  const t = rel.tender ?? {};
  const buyerParty = rel.buyer?.id ? party[rel.buyer.id] : null;
  return {
    party,
    tender: t,
    contract_kind:
      (t.mainProcurementCategory && KIND_CATEGORY[t.mainProcurementCategory]) ||
      t.mainProcurementCategory ||
      null,
    authority_eik:
      buyerParty?.eik ??
      (rel.parties ?? []).find((p) => (p.roles ?? []).includes('buyer'))?.identifier?.id ??
      null,
    authority_name: rel.buyer?.name || buyerParty?.name || null,
    published_at: dateOnly(rel.date ?? meta.publishedDate),
  };
}

function supplierOf(
  rel: OcdsRelease,
  ctx: ReturnType<typeof relContext>,
  contract: { awardID?: string } | undefined,
) {
  const award = (rel.awards ?? []).find((a) => a.id === contract?.awardID);
  const s = (award?.suppliers ?? [])[0];
  const sp = s?.id ? ctx.party[s.id] : null;
  return {
    eik: sp?.eik ?? s?.identifier?.id ?? null,
    name: s?.name || sp?.name || null,
    awardTitle: award?.title || null,
  };
}

/** Flatten a contract-tagged release into raw_contracts staging rows. */
export function releaseToContracts(rel: OcdsRelease, meta: OcdsMeta): ContractStagingRow[] {
  if (!(rel.tag ?? []).includes('contract') || !(rel.contracts ?? []).length) return [];
  const ctx = relContext(rel, meta);
  const t = ctx.tender;
  const procedure_type = t.procurementMethodDetails || t.procurementMethod || null;
  const cpv =
    (t.items ?? []).map((i) => i.classification).find((c) => c && /cpv/i.test(c.scheme ?? ''))
      ?.id ?? null;
  const bids = finiteNum((rel.bids?.statistics ?? []).find((s) => s.measure === 'bids')?.value);
  return (rel.contracts ?? []).map((c) => {
    const sup = supplierOf(rel, ctx, c);
    return {
      ...metaBase(meta),
      dataset_year: boundedYear(meta.year),
      dataset_variant: 'OCDS',
      seq_no: null,
      document_number: rel.id ?? null,
      contract_number: c.id ?? null,
      contract_date: dateOnly(c.dateSigned),
      published_at: ctx.published_at,
      unp: rel.ocid ?? null,
      authority_eik: ctx.authority_eik,
      authority_name: ctx.authority_name,
      procurement_subject: t.title ?? null,
      contract_kind: ctx.contract_kind,
      eu_funded: null,
      bids_received: bids,
      contract_subject: c.title || sup.awardTitle || null,
      contractor_eik: sup.eik,
      contractor_name: sup.name,
      signing_value: finiteNum(c.value?.amount),
      currency: isoCurrency(c.value?.currency),
      vat: null,
      sme: null,
      procedure_type,
      cpv_code: cpv,
      estimated_value: finiteNum(t.value?.amount),
      current_value: null,
      needs_enrichment: 0,
    };
  });
}

export function releaseToAmendments(rel: OcdsRelease, meta: OcdsMeta): AmendmentStagingRow[] {
  const tags = rel.tag ?? [];
  if (
    !(tags.includes('contractAmendment') || tags.includes('contractUpdate')) ||
    !(rel.contracts ?? []).length
  ) {
    return [];
  }
  const ctx = relContext(rel, meta);
  return (rel.contracts ?? []).flatMap((c) => {
    if (!c.id) return [];
    const sup = supplierOf(rel, ctx, c);
    const amd = (c.amendments ?? []).slice(-1)[0] ?? null;
    return [
      {
        ...metaBase(meta),
        dataset_year: boundedYear(meta.year),
        dataset_variant: 'OCDS',
        seq_no: null,
        document_number: rel.id ?? null,
        contract_number: c.id ?? null,
        contract_date: dateOnly(c.dateSigned),
        published_at: ctx.published_at,
        unp: rel.ocid ?? null,
        authority_eik: ctx.authority_eik,
        authority_name: ctx.authority_name,
        procurement_subject: ctx.tender.title ?? null,
        contract_kind: ctx.contract_kind,
        eu_funded: null,
        contract_subject: c.title || sup.awardTitle || null,
        contractor_eik: sup.eik,
        contractor_name: sup.name,
        value_before: null,
        value_after: finiteNum(c.value?.amount),
        value_delta: null,
        currency: isoCurrency(c.value?.currency),
        description: amd?.description || null,
        reason: amd?.rationale || null,
        circumstances: null,
        sme: null,
      },
    ];
  });
}

export function releaseToParties(rel: OcdsRelease, meta: OcdsMeta): PartyStagingRow[] {
  return (rel.parties ?? []).map((p) => {
    const a = p.address ?? {};
    const cp = p.contactPoint ?? {};
    return {
      ...metaBase(meta),
      ocid: rel.ocid ?? null,
      party_id: p.id ?? null,
      eik: p.identifier?.id ?? null,
      scheme: p.identifier?.scheme ?? null,
      name: p.name ?? null,
      roles: (p.roles ?? []).join(',') || null,
      street_address: a.streetAddress ?? null,
      locality: a.locality ?? null,
      postal_code: a.postalCode ?? null,
      region_nuts: a.region ?? null,
      country: a.countryName ?? null,
      contact_name: cp.name ?? null,
      contact_email: cp.email ?? null,
      contact_phone: cp.telephone ?? null,
    };
  });
}

export function releaseToLots(rel: OcdsRelease, meta: OcdsMeta): LotStagingRow[] {
  const t = rel.tender ?? {};
  return (t.lots ?? []).map((lot) => ({
    ...metaBase(meta),
    ocid: rel.ocid ?? null,
    tender_id: t.id ?? null,
    lot_id: lot.id ?? null,
    title: lot.title ?? null,
    value_amount: finiteNum(lot.value?.amount),
    value_currency: isoCurrency(lot.value?.currency),
  }));
}

export type BucketKeyKind = 'contracts' | 'tenders' | 'annexes' | 'ocds';

export function classifyBucketKey(key: string): BucketKeyKind | null {
  if (/OCDS/i.test(key) || key.includes('обявления')) return 'ocds';
  if (key.includes('договори')) return 'contracts';
  if (key.includes('поръчки')) return 'tenders';
  if (key.includes('анекси')) return 'annexes';
  return null;
}

export function computeCatchupWindow({
  maxLoadedDate,
  today,
  lookbackDays,
}: {
  maxLoadedDate: string | null | undefined;
  today: string;
  lookbackDays: number;
}): { from: string; to: string } {
  validateDay(today, 'today');
  if (maxLoadedDate) validateDay(maxLoadedDate, 'maxLoadedDate');
  const from = maxLoadedDate
    ? subtractDays(maxLoadedDate, lookbackDays)
    : subtractDays(today, lookbackDays);
  return { from: from > today ? today : from, to: today };
}

export function daysInWindow(from: string, to: string): number {
  validateDay(from, 'from');
  validateDay(to, 'to');
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (start > end) throw new Error('from must be before or equal to to');
  return Math.floor((end - start) / MS_PER_DAY) + 1;
}

export const CONTRACT_STAGING_COLS: (keyof ContractStagingRow)[] = [
  'source',
  'dataset_uri',
  'resource_uri',
  'dataset_year',
  'dataset_variant',
  'fetched_at',
  'seq_no',
  'document_number',
  'contract_number',
  'contract_date',
  'published_at',
  'unp',
  'authority_eik',
  'authority_name',
  'procurement_subject',
  'contract_kind',
  'eu_funded',
  'bids_received',
  'contract_subject',
  'contractor_eik',
  'contractor_name',
  'signing_value',
  'currency',
  'vat',
  'sme',
  'procedure_type',
  'cpv_code',
  'estimated_value',
  'current_value',
  'needs_enrichment',
];

export const AMENDMENT_STAGING_COLS: (keyof AmendmentStagingRow)[] = [
  'source',
  'dataset_uri',
  'resource_uri',
  'dataset_year',
  'dataset_variant',
  'fetched_at',
  'seq_no',
  'document_number',
  'contract_number',
  'contract_date',
  'published_at',
  'unp',
  'authority_eik',
  'authority_name',
  'procurement_subject',
  'contract_kind',
  'eu_funded',
  'contract_subject',
  'contractor_eik',
  'contractor_name',
  'value_before',
  'value_after',
  'value_delta',
  'currency',
  'description',
  'reason',
  'circumstances',
  'sme',
];

export const PARTY_STAGING_COLS: (keyof PartyStagingRow)[] = [
  'source',
  'dataset_uri',
  'resource_uri',
  'fetched_at',
  'ocid',
  'party_id',
  'eik',
  'scheme',
  'name',
  'roles',
  'street_address',
  'locality',
  'postal_code',
  'region_nuts',
  'country',
  'contact_name',
  'contact_email',
  'contact_phone',
];

export const LOT_STAGING_COLS: (keyof LotStagingRow)[] = [
  'source',
  'dataset_uri',
  'resource_uri',
  'fetched_at',
  'ocid',
  'tender_id',
  'lot_id',
  'title',
  'value_amount',
  'value_currency',
];
