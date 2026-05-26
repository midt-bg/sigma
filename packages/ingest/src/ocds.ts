// OCDS go-forward adapter — discover, fetch, and flatten АОП OCDS release packages into the
// raw_egov_contracts staging shape. The flatten logic mirrors scripts/load-ocds.mjs (the proven CLI
// loader) so the daily Workflow and the bulk loader agree on row shapes; this is the in-Worker port.

const API = 'https://data.egov.bg/api';
const AOP_ORG_ID = 502;

const KIND_CATEGORY: Record<string, string> = {
  goods: 'Доставки',
  services: 'Услуги',
  works: 'Строителство',
};

const dateOnly = (s: unknown): string | null => (s ? String(s).slice(0, 10) : null);

// Minimal shapes of the OCDS fields we read (the feed carries far more; we keep it loose on purpose).
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
  }>;
  buyer?: { id?: string; name?: string };
  tender?: {
    title?: string;
    value?: { amount?: number };
    mainProcurementCategory?: string;
    procurementMethod?: string;
    procurementMethodDetails?: string;
    items?: Array<{ classification?: { id?: string; scheme?: string } }>;
  };
  awards?: Array<{
    id?: string;
    title?: string;
    suppliers?: Array<{ id?: string; name?: string; identifier?: { id?: string } }>;
  }>;
  bids?: { statistics?: Array<{ measure?: string; value?: number }> };
  contracts?: Array<{
    id?: string;
    awardID?: string;
    title?: string;
    dateSigned?: string;
    value?: { amount?: number; currency?: string };
  }>;
}

export interface OcdsPackage {
  publishedDate?: string;
  releases?: OcdsRelease[];
}

export interface OcdsMeta {
  source: string; // e.g. 'ocds:2026:2026-05-01'
  datasetUri: string;
  resourceUri: string;
  year: number | null;
  fetchedAt: string;
}

// The raw_egov_contracts staging row produced from a "contract"-tagged release (needs_enrichment = 0).
export interface ContractStagingRow {
  source: string;
  dataset_uri: string | null;
  resource_uri: string | null;
  dataset_year: number | null;
  dataset_variant: string;
  fetched_at: string;
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
  procedure_type: string | null;
  cpv_code: string | null;
  estimated_value: number | null;
  needs_enrichment: number;
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
    published_at: dateOnly(rel.date),
  };
}

function supplierOf(
  rel: OcdsRelease,
  ctx: ReturnType<typeof relContext>,
  awardID: string | undefined,
) {
  const award = (rel.awards ?? []).find((a) => a.id === awardID);
  const s = (award?.suppliers ?? [])[0];
  const sp = s?.id ? ctx.party[s.id] : null;
  return {
    eik: sp?.eik ?? s?.identifier?.id ?? null,
    name: s?.name || sp?.name || null,
    awardTitle: award?.title || null,
  };
}

/** Flatten a "contract"-tagged release into staging rows (one per contract), like load-ocds.mjs. */
export function releaseToContracts(rel: OcdsRelease, meta: OcdsMeta): ContractStagingRow[] {
  if (!(rel.tag ?? []).includes('contract') || !(rel.contracts ?? []).length) return [];
  const ctx = relContext(rel, meta);
  const t = ctx.tender;
  const procedure_type = t.procurementMethodDetails || t.procurementMethod || null;
  const cpv =
    (t.items ?? []).map((i) => i.classification).find((c) => c && /cpv/i.test(c.scheme ?? ''))
      ?.id ?? null;
  const bids = (rel.bids?.statistics ?? []).find((s) => s.measure === 'bids')?.value ?? null;
  return (rel.contracts ?? []).map((c) => {
    const sup = supplierOf(rel, ctx, c.awardID);
    return {
      source: meta.source,
      dataset_uri: meta.datasetUri,
      resource_uri: meta.resourceUri,
      dataset_year: meta.year,
      dataset_variant: 'OCDS',
      fetched_at: meta.fetchedAt,
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
      signing_value: c.value?.amount ?? null,
      currency: c.value?.currency ?? null,
      procedure_type,
      cpv_code: cpv,
      estimated_value: t.value?.amount ?? null,
      needs_enrichment: 0,
    };
  });
}

export interface OcdsDataset {
  uri: string;
  name: string;
  periodStart: string | null;
  year: number | null;
}

async function postJSON(method: string, body: unknown): Promise<any> {
  const resp = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${method}: HTTP ${resp.status}`);
  return resp.json();
}

/** Discover АОП OCDS datasets (newest period first). Mirrors load-ocds.mjs discoverOcdsDatasets. */
export async function discoverOcdsDatasets(): Promise<OcdsDataset[]> {
  const r = await postJSON('listDatasets', {
    criteria: { org_ids: [AOP_ORG_ID] },
    records_per_page: 200,
  });
  const out: OcdsDataset[] = [];
  for (const ds of r.datasets ?? []) {
    if (!/стандарт\s+OCDS/i.test(ds.name ?? '')) continue;
    const m = (ds.name ?? '').match(/от\s+(\d{2})-(\d{2})-(\d{4})\s+до\s+(\d{2})-(\d{2})-(\d{4})/);
    const periodStart = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    out.push({ uri: ds.uri, name: ds.name, periodStart, year: m ? Number(m[3]) : null });
  }
  return out.sort((a, b) => (b.periodStart ?? '').localeCompare(a.periodStart ?? ''));
}

/** The first JSON resource of a dataset. */
export async function findJsonResource(datasetUri: string): Promise<{ uri: string } | null> {
  const r = await postJSON('listResources', { criteria: { dataset_uri: datasetUri } });
  const rs = r.resources ?? [];
  return rs.find((x: any) => /json/i.test(x.file_format || x.format || '')) || rs[0] || null;
}

/** Fetch one OCDS resource package (the full release-package JSON). */
export async function fetchOcdsPackage(resourceUri: string): Promise<OcdsPackage> {
  const resp = await fetch(`${API}/getResourceData`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_uri: resourceUri }),
  });
  if (!resp.ok) throw new Error(`getResourceData ${resourceUri}: HTTP ${resp.status}`);
  const json = (await resp.json()) as { data?: OcdsPackage };
  return json.data ?? {};
}

export const CONTRACT_STAGING_COLS: (keyof ContractStagingRow)[] = [
  'source',
  'dataset_uri',
  'resource_uri',
  'dataset_year',
  'dataset_variant',
  'fetched_at',
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
  'procedure_type',
  'cpv_code',
  'estimated_value',
  'needs_enrichment',
];
