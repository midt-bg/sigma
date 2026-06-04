#!/usr/bin/env node
// Pull the АОП "Договори и изменения" contract register from the data.egov.bg open
// data portal (org 502) into SQL INSERTs for raw_egov_contracts (see
// packages/db/migrations/0003_egov_staging.sql), then optionally load local D1.
//
//   node scripts/load-egov.mjs                 # list the discovered datasets (catalog)
//   node scripts/load-egov.mjs --year=2023     # parse 2023 → data/egov-load.sql
//   node scripts/load-egov.mjs --all --apply   # all years → migrate + load local D1
//
//   flags: --year=YYYY | --all   pick scope (one is required to fetch)
//          --variant=CE|ROP      restrict to ЦАИС ЕОП or РОП source (default both)
//          --apply               also: migrate + load into D1
//          --remote              apply against the REMOTE D1 (needs `wrangler login`
//                                + a real database_id; default is --local)
//          --refresh             re-download even if a cached copy exists
//
// The portal has no api_key for reads. getResourceData returns the whole file as
// JSON (header in row 0); we map columns BY BULGARIAN HEADER NAME so the parser
// survives year-to-year column drift. The open CSV lacks procedure_type / CPV /
// estimated_value, so every row is flagged needs_enrichment = 1 for a later pass
// (admin ЦАИС export or OCDS) that fills those in, joined on УНП.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const cacheDir = resolve(root, 'data/egov'); // gitignored
const outFile = resolve(root, 'data/egov-load.sql');
const API = 'https://data.egov.bg/api';
const AOP_ORG_ID = 502;

// D1 caps one statement at 100 KB; Cyrillic is 2 UTF-8 bytes/char, so budget by bytes.
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

// Mapped columns: [staging field, [header aliases], coercion kind]. Headers are matched
// case-insensitively, so BOTH АОП schemas are covered: the ЦАИС ЕОП names and the older
// РОП names (e.g. УНП vs "Уникален номер на поръчката", ДОГОВОР НОМЕР vs "Номер на договор",
// and uppercased variants). First matching alias wins; an unmatched field yields NULL.
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const FIELDS = [
  ['seq_no', ['Пореден номер'], 'text'],
  ['document_number', ['Номер на документ', 'ID на документ'], 'text'],
  ['contract_number', ['Номер на договор', 'ДОГОВОР НОМЕР'], 'text'],
  ['contract_date', ['Дата на договор', 'ДОГОВОР ДАТА'], 'date'],
  ['published_at', ['Публикуван на'], 'date'],
  ['unp', ['Уникален номер на поръчката', 'УНП'], 'text'],
  ['authority_eik', ['ЕИК на възложителя'], 'text'],
  ['authority_name', ['Възложител'], 'text'],
  ['procurement_subject', ['Предмет на поръчката'], 'text'],
  ['contract_kind', ['Обект на поръчката', 'Обект'], 'text'],
  ['eu_funded', ['EU финансиране'], 'bool'],
  ['bids_received', ['Брой оферти'], 'int'],
  ['contract_subject', ['Предмет на договора'], 'text'],
  ['contractor_eik', ['ЕИК на изпълнителя'], 'text'],
  ['contractor_name', ['Изпълнител'], 'text'],
  ['signing_value', ['Стойност при сключване'], 'real'],
  ['currency', ['Валута'], 'text'],
  ['vat', ['ДДС'], 'text'],
  ['sme', ['Малко или средно предприятие (МСП)'], 'text'],
];
const META_COLS = [
  'source',
  'dataset_uri',
  'resource_uri',
  'dataset_year',
  'dataset_variant',
  'fetched_at',
];
const INSERT_COLS = [...META_COLS, ...FIELDS.map(([f]) => f), 'needs_enrichment'];

// --- value coercion ---------------------------------------------------------
// Open-data cells arrive wrapped in literal quotes ("112181", "000708921"); strip
// one balanced layer but leave internal quotes (e.g. company names) intact.
function clean(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  return s === '' ? null : s;
}
function toInt(v) {
  const s = clean(v);
  if (s === null) return null;
  const n = parseInt(s.replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function toReal(v) {
  const s = clean(v);
  if (s === null) return null;
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (['true', 'да', '1', 'yes'].includes(t)) return 1;
  if (['false', 'не', '0', 'no'].includes(t)) return 0;
  return null;
}
function toISODate(v) {
  const s = clean(v);
  if (s === null) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); // DD/MM/YYYY
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}
function coerce(kind, v) {
  switch (kind) {
    case 'int':
      return toInt(v);
    case 'real':
      return toReal(v);
    case 'bool':
      return toBool(v);
    case 'date':
      return toISODate(v);
    default:
      return clean(v);
  }
}
function sqlLiteral(kind, value) {
  if (value === null) return 'NULL';
  if (kind === 'int' || kind === 'real' || kind === 'bool') return String(value);
  return `'${String(value)
    .replace(/[\x00-\x1F]/g, '')
    .replace(/'/g, "''")}'`;
}

// --- portal API -------------------------------------------------------------
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
  const cacheFile = resolve(cacheDir, `${resourceUri}.json`);
  if (!refresh && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }
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

// Discover the annual "Договори и изменения" contract datasets for АОП.
async function discoverContractDatasets() {
  const r = await postJSON('listDatasets', {
    criteria: { org_ids: [AOP_ORG_ID] },
    records_per_page: 200,
  });
  const out = [];
  for (const ds of r.datasets || []) {
    const m = (ds.name || '').match(/Договори и изменения на договори\s*-\s*(\d{4})\b/);
    if (!m) continue; // skips OCDS, the 2007–2015 list, partial-quarter sets, etc.
    const variant = /ЦАИС\s*ЕОП/i.test(ds.name) ? 'CE' : /РОП/i.test(ds.name) ? 'ROP' : 'NA';
    out.push({ year: Number(m[1]), variant, uri: ds.uri, name: ds.name });
  }
  return out.sort((a, b) => b.year - a.year || a.variant.localeCompare(b.variant));
}

// Pick the contracts CSV resource (not annexes / excl) from a dataset.
async function findContractsResource(datasetUri) {
  const r = await postJSON('listResources', { criteria: { dataset_uri: datasetUri } });
  const rs = r.resources || [];
  return (
    rs.find((x) => /contracts.*\.csv/i.test(x.name || '')) ||
    rs.find((x) => /Договори,\s*сключени/i.test(x.name || '')) ||
    null
  );
}

// --- main -------------------------------------------------------------------
function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}

async function main() {
  const all = !!arg('all');
  const year = arg('year') ? Number(arg('year')) : undefined;
  const variant = arg('variant'); // 'CE' | 'ROP'
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const refresh = !!arg('refresh');

  process.stderr.write('==> discovering АОП contract datasets…\n');
  let datasets = await discoverContractDatasets();
  if (variant) datasets = datasets.filter((d) => d.variant === variant);

  if (!all && year === undefined) {
    process.stderr.write(
      `\nDiscovered ${datasets.length} contract datasets (org ${AOP_ORG_ID}):\n`,
    );
    for (const d of datasets)
      process.stderr.write(`  ${d.year} ${d.variant}  ${d.uri}  ${d.name}\n`);
    process.stderr.write(
      '\nPick scope to fetch: --year=YYYY or --all  (add --apply to load D1).\n',
    );
    return;
  }
  const selected = all ? datasets : datasets.filter((d) => d.year === year);
  if (selected.length === 0) {
    process.stderr.write(`No datasets matched (year=${year}, variant=${variant ?? 'any'}).\n`);
    process.exitCode = 1;
    return;
  }

  const out = createWriteStream(outFile, { encoding: 'utf8' });
  await writeChunk(
    out,
    `-- Generated by scripts/load-egov.mjs — do not edit by hand.\n` +
      `-- АОП open-data contract register (data.egov.bg). All rows: needs_enrichment = 1.\n` +
      `-- Scoped wipe so the OCDS feed (source 'ocds:%', loaded by load-ocds.mjs) coexists.\n` +
      `DELETE FROM raw_egov_contracts WHERE source LIKE 'egov:%';\n`,
  );
  const header = `INSERT INTO raw_egov_contracts (${INSERT_COLS.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');

  let grand = 0;
  let maxStmtBytes = 0;
  const perDataset = {};

  for (const ds of selected) {
    const res = await findContractsResource(ds.uri);
    if (!res) {
      process.stderr.write(`!! ${ds.year} ${ds.variant}: no contracts resource found — skipping\n`);
      continue;
    }
    process.stderr.write(`==> ${ds.year} ${ds.variant}: fetching ${res.uri}\n`);
    const data = await getResourceData(res.uri, refresh);
    const rows = data.data || [];
    if (rows.length < 2) {
      process.stderr.write(`   (empty)\n`);
      continue;
    }
    const head = rows[0].map((h) => String(h).trim());
    const pos = {}; // normalised header name -> column index
    head.forEach((h, i) => (pos[norm(h)] = i));

    const source = `egov:contracts:${ds.year}:${ds.variant}`;
    const meta = [source, ds.uri, res.uri, ds.year, ds.variant, fetchedAt];
    const metaLiteral = META_COLS.map((_, i) =>
      typeof meta[i] === 'number' ? String(meta[i]) : sqlLiteral('text', meta[i]),
    );

    let batch = [];
    let stmtBytes = headerBytes;
    let count = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const stmt = header + batch.join(',\n') + ';\n';
      maxStmtBytes = Math.max(maxStmtBytes, Buffer.byteLength(stmt, 'utf8'));
      await writeChunk(out, stmt);
      batch = [];
      stmtBytes = headerBytes;
    };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const vals = [...metaLiteral];
      for (const [, aliases, kind] of FIELDS) {
        let i;
        for (const a of aliases) {
          const p = pos[norm(a)];
          if (p !== undefined) {
            i = p;
            break;
          }
        }
        vals.push(sqlLiteral(kind, i === undefined ? null : coerce(kind, row[i])));
      }
      vals.push('1'); // needs_enrichment
      const tuple = `(${vals.join(',')})`;
      const tupleBytes = Buffer.byteLength(tuple, 'utf8') + 2;
      if (
        batch.length > 0 &&
        (batch.length >= MAX_BATCH_ROWS || stmtBytes + tupleBytes > MAX_BATCH_BYTES)
      ) {
        await flush();
      }
      batch.push(tuple);
      stmtBytes += tupleBytes;
      count++;
    }
    await flush();
    perDataset[source] = count;
    grand += count;
    process.stderr.write(`   ${count.toLocaleString('en-US')} rows\n`);
  }

  out.end();
  await once(out, 'finish');
  process.stderr.write(
    `==> wrote ${grand.toLocaleString('en-US')} rows → ${outFile} ` +
      `(largest statement ${maxStmtBytes.toLocaleString('en-US')} bytes)\n`,
  );

  if (!apply) {
    process.stderr.write(
      `\nNext: apply migration + load into local D1:\n` +
        `  (cd apps/api && wrangler d1 migrations apply sigma --local)\n` +
        `  (cd apps/api && wrangler d1 execute sigma --local --file ${outFile})\n` +
        `Or re-run with --apply.\n`,
    );
    return;
  }
  const scope = remote ? '--remote' : '--local';
  const run = (a) => {
    process.stderr.write(`==> wrangler ${a.join(' ')}\n`);
    execFileSync('wrangler', a, { stdio: 'inherit', cwd: apiDir });
  };
  run(['d1', 'migrations', 'apply', 'sigma', scope]);
  run(['d1', 'execute', 'sigma', scope, '--file', outFile]);
  process.stderr.write(`\n==> done: ${JSON.stringify(perDataset)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
