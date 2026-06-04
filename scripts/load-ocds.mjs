#!/usr/bin/env node
// Pull the АОП OCDS feed (2026+, "съгласно стандарт OCDS") from data.egov.bg (org
// 502) and flatten it into raw_egov_contracts + raw_egov_amendments — the SAME staging
// tables the open-data CSVs use (migrations 0003/0004).
//
//   node scripts/load-ocds.mjs                # list the discovered OCDS datasets
//   node scripts/load-ocds.mjs --all          # all periods → data/ocds-load.sql (+ amendments)
//   node scripts/load-ocds.mjs --all --apply  # also: migrate + load local D1
//
//   flags: --all | --limit=N, --apply, --remote, --refresh
//
// Each release is a snapshot. "contract"-tagged releases → one contract row each
// (procedure_type / cpv_code / estimated_value FILLED → needs_enrichment = 0).
// "contractAmendment" / "contractUpdate" releases → amendment rows. Wipes are scoped
// to source 'ocds:%' so the CSV feeds ('egov:%') are untouched.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const cacheDir = resolve(root, 'data/egov');
const contractsFile = resolve(root, 'data/ocds-load.sql');
const amendFile = resolve(root, 'data/ocds-amendments-load.sql');
const partiesFile = resolve(root, 'data/ocds-parties-load.sql');
const awardSuppliersFile = resolve(root, 'data/ocds-award-suppliers-load.sql');
const API = 'https://data.egov.bg/api';
const AOP_ORG_ID = 502;
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

// raw_egov_contracts insert order (must match load-egov.mjs).
const CONTRACT_COLS = [
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
// raw_egov_amendments insert order (must match load-annexes.mjs).
const AMEND_COLS = [
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
// raw_ocds_parties insert order.
const PARTY_COLS = [
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
// raw_ocds_award_suppliers insert order (all suppliers per award; >1 = joint venture / consortium).
const AWARD_SUPPLIER_COLS = [
  'source',
  'dataset_uri',
  'resource_uri',
  'fetched_at',
  'ocid',
  'award_id',
  'supplier_count',
  'supplier_eik',
  'supplier_name',
];
const COL_KIND = {
  dataset_year: 'int',
  eu_funded: 'int',
  bids_received: 'int',
  signing_value: 'real',
  estimated_value: 'real',
  current_value: 'real',
  needs_enrichment: 'int',
  value_before: 'real',
  value_after: 'real',
  value_delta: 'real',
  supplier_count: 'int',
};
const KIND_CATEGORY = { goods: 'Доставки', services: 'Услуги', works: 'Строителство' };

function sqlLiteral(col, value) {
  if (value === null || value === undefined) return 'NULL';
  const kind = COL_KIND[col];
  if (kind === 'int' || kind === 'real') {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  return `'${String(value)
    .replace(/[\x00-\x1F]/g, '')
    .replace(/'/g, "''")}'`;
}
const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);
function cachePath(resourceUri) {
  const safeUri = String(resourceUri);
  if (!/^[A-Za-z0-9_.-]+$/.test(safeUri)) throw new Error(`invalid resource_uri: ${resourceUri}`);
  const file = resolve(cacheDir, `${safeUri}.json`);
  const rel = relative(cacheDir, file);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`${sep}`)) {
    throw new Error(`resource_uri escapes cache dir: ${resourceUri}`);
  }
  return file;
}

async function postJSON(method, body) {
  const resp = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${method}: HTTP ${resp.status}`);
  return resp.json();
}
async function getResourceData(resourceUri, refresh) {
  const cacheFile = cachePath(resourceUri);
  if (!refresh && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const resp = await fetch(`${API}/getResourceData`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_uri: resourceUri }),
  });
  if (!resp.ok) throw new Error(`getResourceData ${resourceUri}: HTTP ${resp.status}`);
  const text = await resp.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, text);
  return JSON.parse(text);
}
async function discoverOcdsDatasets() {
  const r = await postJSON('listDatasets', {
    criteria: { org_ids: [AOP_ORG_ID] },
    records_per_page: 200,
  });
  const out = [];
  for (const ds of r.datasets || []) {
    if (!/стандарт\s+OCDS/i.test(ds.name || '')) continue;
    const m = (ds.name || '').match(/от\s+(\d{2})-(\d{2})-(\d{4})\s+до\s+(\d{2})-(\d{2})-(\d{4})/);
    const periodStart = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    out.push({ uri: ds.uri, name: ds.name, periodStart, year: m ? Number(m[3]) : null });
  }
  return out.sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''));
}
async function findJsonResource(datasetUri) {
  const r = await postJSON('listResources', { criteria: { dataset_uri: datasetUri } });
  const rs = r.resources || [];
  return rs.find((x) => /json/i.test(x.file_format || x.format || '')) || rs[0] || null;
}

// Shared per-release context: party map + buyer/tender fields used by both row kinds.
function relContext(rel, meta) {
  const party = {};
  for (const p of rel.parties || [])
    party[p.id] = { eik: p.identifier?.id ?? null, name: p.name ?? null };
  const t = rel.tender || {};
  const buyerParty = rel.buyer?.id ? party[rel.buyer.id] : null;
  return {
    party,
    tender: t,
    contract_kind: KIND_CATEGORY[t.mainProcurementCategory] || t.mainProcurementCategory || null,
    authority_eik:
      buyerParty?.eik ??
      (rel.parties || []).find((p) => (p.roles || []).includes('buyer'))?.identifier?.id ??
      null,
    authority_name: rel.buyer?.name || buyerParty?.name || null,
    published_at: dateOnly(rel.date || meta.publishedDate),
  };
}
function supplierOf(rel, ctx, c) {
  const award = (rel.awards || []).find((a) => a.id === c.awardID);
  const s = (award?.suppliers || [])[0];
  const sp = s?.id ? ctx.party[s.id] : null;
  return {
    eik: sp?.eik ?? s?.identifier?.id ?? null,
    name: s?.name || sp?.name || null,
    awardTitle: award?.title || null,
  };
}

function releaseToContracts(rel, meta) {
  if (!(rel.tag || []).includes('contract') || !(rel.contracts || []).length) return [];
  const ctx = relContext(rel, meta);
  const t = ctx.tender;
  const procedure_type = t.procurementMethodDetails || t.procurementMethod || null;
  const cpv =
    (t.items || []).map((i) => i.classification).find((c) => c && /cpv/i.test(c.scheme || ''))
      ?.id ?? null;
  const bids = (rel.bids?.statistics || []).find((s) => s.measure === 'bids')?.value ?? null;
  return rel.contracts.map((c) => {
    const sup = supplierOf(rel, ctx, c);
    return {
      source: meta.source,
      dataset_uri: meta.dataset_uri,
      resource_uri: meta.resource_uri,
      dataset_year: meta.year,
      dataset_variant: 'OCDS',
      fetched_at: meta.fetchedAt,
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
      signing_value: c.value?.amount ?? null,
      currency: c.value?.currency ?? null,
      vat: null,
      sme: null,
      procedure_type,
      cpv_code: cpv,
      estimated_value: t.value?.amount ?? null,
      current_value: null,
      needs_enrichment: 0,
    };
  });
}

function releaseToAmendments(rel, meta) {
  const tags = rel.tag || [];
  if (
    !(tags.includes('contractAmendment') || tags.includes('contractUpdate')) ||
    !(rel.contracts || []).length
  )
    return [];
  const ctx = relContext(rel, meta);
  return rel.contracts.map((c) => {
    const sup = supplierOf(rel, ctx, c);
    const amd = (c.amendments || []).slice(-1)[0] || null; // latest amendment for rationale/description
    return {
      source: meta.source,
      dataset_uri: meta.dataset_uri,
      resource_uri: meta.resource_uri,
      dataset_year: meta.year,
      dataset_variant: 'OCDS',
      fetched_at: meta.fetchedAt,
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
      value_after: c.value?.amount ?? null,
      value_delta: null,
      currency: c.value?.currency ?? null,
      description: amd?.description || null,
      reason: amd?.rationale || null,
      circumstances: null,
      sme: null,
    };
  });
}

// Every party in the release → one row (full capture: ЕИК, name, roles, address, contact).
function releaseToParties(rel, meta) {
  return (rel.parties || []).map((p) => {
    const a = p.address || {};
    const cp = p.contactPoint || {};
    return {
      source: meta.source,
      dataset_uri: meta.dataset_uri,
      resource_uri: meta.resource_uri,
      fetched_at: meta.fetchedAt,
      ocid: rel.ocid ?? null,
      party_id: p.id ?? null,
      eik: p.identifier?.id ?? null,
      scheme: p.identifier?.scheme ?? null,
      name: p.name ?? null,
      roles: (p.roles || []).join(',') || null,
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

// Every supplier on every award → one row. supplier_count > 1 marks a joint venture / consortium.
function releaseToAwardSuppliers(rel, meta) {
  const party = {};
  for (const p of rel.parties || [])
    party[p.id] = { eik: p.identifier?.id ?? null, name: p.name ?? null };
  const out = [];
  for (const aw of rel.awards || []) {
    const sups = aw.suppliers || [];
    for (const s of sups) {
      const sp = s.id ? party[s.id] : null;
      out.push({
        source: meta.source,
        dataset_uri: meta.dataset_uri,
        resource_uri: meta.resource_uri,
        fetched_at: meta.fetchedAt,
        ocid: rel.ocid ?? null,
        award_id: aw.id ?? null,
        supplier_count: sups.length,
        supplier_eik: sp?.eik ?? s.identifier?.id ?? null,
        supplier_name: s.name || sp?.name || null,
      });
    }
  }
  return out;
}

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}
function makeBatcher(out, header) {
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let batch = [];
  let stmtBytes = headerBytes;
  let max = 0;
  const flush = async () => {
    if (!batch.length) return;
    const stmt = header + batch.join(',\n') + ';\n';
    max = Math.max(max, Buffer.byteLength(stmt, 'utf8'));
    await writeChunk(out, stmt);
    batch = [];
    stmtBytes = headerBytes;
  };
  const push = async (tuple) => {
    const tb = Buffer.byteLength(tuple, 'utf8') + 2;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES))
      await flush();
    batch.push(tuple);
    stmtBytes += tb;
  };
  return { push, flush, max: () => max };
}

async function main() {
  const all = !!arg('all');
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const refresh = !!arg('refresh');

  process.stderr.write('==> discovering АОП OCDS datasets…\n');
  let datasets = await discoverOcdsDatasets();
  if (!all && limit === undefined) {
    process.stderr.write(`\nDiscovered ${datasets.length} OCDS datasets:\n`);
    for (const d of datasets) process.stderr.write(`  ${d.periodStart}  ${d.uri}  ${d.name}\n`);
    process.stderr.write('\nPick scope: --all or --limit=N  (add --apply to load D1).\n');
    return;
  }
  if (limit !== undefined) datasets = datasets.slice(0, limit);

  const cOut = createWriteStream(contractsFile, { encoding: 'utf8' });
  const aOut = createWriteStream(amendFile, { encoding: 'utf8' });
  const pOut = createWriteStream(partiesFile, { encoding: 'utf8' });
  const sOut = createWriteStream(awardSuppliersFile, { encoding: 'utf8' });
  await writeChunk(
    cOut,
    `-- Generated by scripts/load-ocds.mjs — do not edit by hand.\n` +
      `-- АОП OCDS contracts (2026+). needs_enrichment = 0.\n` +
      `DELETE FROM raw_egov_contracts WHERE source LIKE 'ocds:%';\n`,
  );
  await writeChunk(
    aOut,
    `-- Generated by scripts/load-ocds.mjs — do not edit by hand.\n` +
      `-- АОП OCDS amendments (contractAmendment releases, 2026+).\n` +
      `DELETE FROM raw_egov_amendments WHERE source LIKE 'ocds:%';\n`,
  );
  await writeChunk(
    pOut,
    `-- Generated by scripts/load-ocds.mjs — do not edit by hand.\n` +
      `-- АОП OCDS parties (ЕИК + address + roles, 2026+).\n` +
      `DELETE FROM raw_ocds_parties WHERE source LIKE 'ocds:%';\n`,
  );
  await writeChunk(
    sOut,
    `-- Generated by scripts/load-ocds.mjs — do not edit by hand.\n` +
      `-- АОП OCDS award suppliers (all suppliers per award; >1 = joint venture / consortium, 2026+).\n` +
      `DELETE FROM raw_ocds_award_suppliers WHERE source LIKE 'ocds:%';\n`,
  );
  const cb = makeBatcher(
    cOut,
    `INSERT INTO raw_egov_contracts (${CONTRACT_COLS.join(', ')}) VALUES\n`,
  );
  const ab = makeBatcher(
    aOut,
    `INSERT INTO raw_egov_amendments (${AMEND_COLS.join(', ')}) VALUES\n`,
  );
  const pb = makeBatcher(pOut, `INSERT INTO raw_ocds_parties (${PARTY_COLS.join(', ')}) VALUES\n`);
  const sb = makeBatcher(
    sOut,
    `INSERT INTO raw_ocds_award_suppliers (${AWARD_SUPPLIER_COLS.join(', ')}) VALUES\n`,
  );
  const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
  let contractRows = 0;
  let amendRows = 0;
  let partyRows = 0;
  let supplierRows = 0;

  for (const ds of datasets) {
    const res = await findJsonResource(ds.uri);
    if (!res) {
      process.stderr.write(`!! ${ds.periodStart}: no JSON resource — skipping\n`);
      continue;
    }
    process.stderr.write(`==> ${ds.periodStart}: fetching ${res.uri}\n`);
    const pkg = (await getResourceData(res.uri, refresh)).data || {};
    const meta = {
      source: `ocds:${ds.year}:${ds.periodStart}`,
      dataset_uri: ds.uri,
      resource_uri: res.uri,
      year: ds.year,
      fetchedAt,
      publishedDate: pkg.publishedDate,
    };
    let cN = 0;
    let aN = 0;
    let pN = 0;
    let sN = 0;
    for (const rel of pkg.releases || []) {
      for (const row of releaseToContracts(rel, meta)) {
        await cb.push(`(${CONTRACT_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
        cN++;
      }
      for (const row of releaseToAmendments(rel, meta)) {
        await ab.push(`(${AMEND_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
        aN++;
      }
      for (const row of releaseToParties(rel, meta)) {
        await pb.push(`(${PARTY_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
        pN++;
      }
      for (const row of releaseToAwardSuppliers(rel, meta)) {
        await sb.push(`(${AWARD_SUPPLIER_COLS.map((c) => sqlLiteral(c, row[c])).join(',')})`);
        sN++;
      }
    }
    await cb.flush();
    await ab.flush();
    await pb.flush();
    await sb.flush();
    contractRows += cN;
    amendRows += aN;
    partyRows += pN;
    supplierRows += sN;
    process.stderr.write(
      `   ${cN.toLocaleString('en-US')} contracts, ${aN.toLocaleString('en-US')} amendments, ${pN.toLocaleString('en-US')} parties, ${sN.toLocaleString('en-US')} award-suppliers\n`,
    );
  }

  cOut.end();
  aOut.end();
  pOut.end();
  sOut.end();
  await Promise.all([
    once(cOut, 'finish'),
    once(aOut, 'finish'),
    once(pOut, 'finish'),
    once(sOut, 'finish'),
  ]);
  process.stderr.write(
    `==> wrote ${contractRows.toLocaleString('en-US')} contracts + ${amendRows.toLocaleString('en-US')} amendments + ` +
      `${partyRows.toLocaleString('en-US')} parties + ${supplierRows.toLocaleString('en-US')} award-suppliers ` +
      `(largest stmt ${Math.max(cb.max(), ab.max(), pb.max(), sb.max()).toLocaleString('en-US')} bytes)\n`,
  );

  if (!apply) {
    process.stderr.write(
      `\nNext: load ${contractsFile} and ${amendFile}, then run derive-amendments.sql.\n`,
    );
    return;
  }
  const scope = remote ? '--remote' : '--local';
  const runW = (a) => {
    process.stderr.write(`==> wrangler ${a.join(' ')}\n`);
    execFileSync('wrangler', a, { stdio: 'inherit', cwd: apiDir });
  };
  runW(['d1', 'migrations', 'apply', 'sigma', scope]);
  runW(['d1', 'execute', 'sigma', scope, '--file', contractsFile]);
  runW(['d1', 'execute', 'sigma', scope, '--file', amendFile]);
  runW(['d1', 'execute', 'sigma', scope, '--file', partiesFile]);
  runW(['d1', 'execute', 'sigma', scope, '--file', awardSuppliersFile]);
  process.stderr.write(
    `\n==> done: ${contractRows} contracts, ${amendRows} amendments, ${partyRows} parties, ${supplierRows} award-suppliers\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
