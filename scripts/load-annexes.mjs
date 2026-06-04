#!/usr/bin/env node
// Pull the АОП amendments (изменения / анекси) from the same "Договори и изменения"
// datasets on data.egov.bg (org 502) into raw_egov_amendments (see
// packages/db/migrations/0004_egov_amendments.sql). One row per amendment.
//
//   node scripts/load-annexes.mjs                # list datasets (catalog)
//   node scripts/load-annexes.mjs --year=2023    # parse 2023 annexes → data/annexes-load.sql
//   node scripts/load-annexes.mjs --all --apply  # all years → migrate + load local D1
//
//   flags: --year=YYYY | --all, --variant=CE|ROP, --apply, --remote, --refresh
//
// Sibling of load-egov.mjs (which pulls the contracts resource of the same datasets);
// this one picks the annexes resource and maps its 22 columns by Bulgarian header name.
// After loading, run scripts/derive-amendments.sql to roll current_value + annex_count
// onto raw_egov_contracts. The wipe is scoped to source 'egov:%' (CSV annexes), leaving
// the OCDS 'ocds:%' amendments (from load-ocds.mjs) intact.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const cacheDir = resolve(root, 'data/egov'); // shared cache, gitignored
const outFile = resolve(root, 'data/annexes-load.sql');
const API = 'https://data.egov.bg/api';
const AOP_ORG_ID = 502;
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

// [field, [header aliases], kind] — matched case-insensitively to cover both the ЦАИС
// ЕОП and older РОП annexes schemas (e.g. УНП vs "Уникален номер на поръчката",
// ДОГОВОР НОМЕР vs "Номер на договор", uppercased variants). First matching alias wins.
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const FIELDS = [
  ['seq_no', ['Пореден номер'], 'text'],
  ['document_number', ['Номер на документ', 'ID на документ'], 'text'],
  ['contract_number', ['Номер на договор', 'ДОГОВОР НОМЕР'], 'text'],
  ['contract_date', ['Дата на договор'], 'date'],
  ['published_at', ['Публикуван на'], 'date'],
  ['unp', ['Уникален номер на поръчката', 'УНП'], 'text'],
  ['authority_eik', ['ЕИК на възложителя'], 'text'],
  ['authority_name', ['Възложител'], 'text'],
  ['procurement_subject', ['Предмет на поръчката'], 'text'],
  ['contract_kind', ['Обект на поръчката', 'Обект'], 'text'],
  ['eu_funded', ['EU финансиране'], 'bool'],
  ['contract_subject', ['Предмет на договора'], 'text'],
  ['contractor_eik', ['ЕИК на изпълнителя'], 'text'],
  ['contractor_name', ['Изпълнител'], 'text'],
  ['value_before', ['Стойност преди изменението'], 'real'],
  ['value_after', ['Стойност след изменението'], 'real'],
  ['value_delta', ['Изменение на стойността'], 'real'],
  ['currency', ['Валута'], 'text'],
  ['description', ['Описание на измененията'], 'text'],
  ['reason', ['Причини за изменение'], 'text'],
  ['circumstances', ['Обстоятелства'], 'text'],
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
const INSERT_COLS = [...META_COLS, ...FIELDS.map(([f]) => f)];

function clean(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  return s === '' ? null : s;
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
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}
function coerce(kind, v) {
  if (kind === 'real') return toReal(v);
  if (kind === 'bool') return toBool(v);
  if (kind === 'date') return toISODate(v);
  return clean(v);
}
function sqlLiteral(kind, value) {
  if (value === null) return 'NULL';
  if (kind === 'real' || kind === 'bool') return String(value);
  return `'${String(value)
    .replace(/[\x00-\x1F]/g, '')
    .replace(/'/g, "''")}'`;
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
  const cacheFile = resolve(cacheDir, `${resourceUri}.json`);
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
async function discoverDatasets() {
  const r = await postJSON('listDatasets', {
    criteria: { org_ids: [AOP_ORG_ID] },
    records_per_page: 200,
  });
  const out = [];
  for (const ds of r.datasets || []) {
    const m = (ds.name || '').match(/Договори и изменения на договори\s*-\s*(\d{4})\b/);
    if (!m) continue;
    const variant = /ЦАИС\s*ЕОП/i.test(ds.name) ? 'CE' : /РОП/i.test(ds.name) ? 'ROP' : 'NA';
    out.push({ year: Number(m[1]), variant, uri: ds.uri, name: ds.name });
  }
  return out.sort((a, b) => b.year - a.year || a.variant.localeCompare(b.variant));
}
async function findAnnexesResource(datasetUri) {
  const r = await postJSON('listResources', { criteria: { dataset_uri: datasetUri } });
  const rs = r.resources || [];
  return (
    rs.find((x) => /annexes.*\.csv/i.test(x.name || '')) ||
    rs.find((x) => /Информация за изменения/i.test(x.name || '')) ||
    null
  );
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

async function main() {
  const all = !!arg('all');
  const year = arg('year') ? Number(arg('year')) : undefined;
  const variant = arg('variant');
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const refresh = !!arg('refresh');

  process.stderr.write('==> discovering АОП "Договори и изменения" datasets…\n');
  let datasets = await discoverDatasets();
  if (variant) datasets = datasets.filter((d) => d.variant === variant);

  if (!all && year === undefined) {
    process.stderr.write(`\nDiscovered ${datasets.length} datasets:\n`);
    for (const d of datasets) process.stderr.write(`  ${d.year} ${d.variant}  ${d.uri}\n`);
    process.stderr.write('\nPick scope: --year=YYYY or --all  (add --apply to load D1).\n');
    return;
  }
  const selected = all ? datasets : datasets.filter((d) => d.year === year);
  if (selected.length === 0) {
    process.stderr.write(`No datasets matched.\n`);
    process.exitCode = 1;
    return;
  }

  const out = createWriteStream(outFile, { encoding: 'utf8' });
  await writeChunk(
    out,
    `-- Generated by scripts/load-annexes.mjs — do not edit by hand.\n` +
      `-- АОП amendments (изменения). Scoped wipe leaves the OCDS 'ocds:%' amendments.\n` +
      `DELETE FROM raw_egov_amendments WHERE source LIKE 'egov:%';\n`,
  );
  const header = `INSERT INTO raw_egov_amendments (${INSERT_COLS.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
  let grand = 0;
  let maxStmtBytes = 0;
  const perDataset = {};

  for (const ds of selected) {
    const res = await findAnnexesResource(ds.uri);
    if (!res) {
      process.stderr.write(`!! ${ds.year} ${ds.variant}: no annexes resource — skipping\n`);
      continue;
    }
    process.stderr.write(`==> ${ds.year} ${ds.variant}: fetching ${res.uri}\n`);
    const rows = (await getResourceData(res.uri, refresh)).data || [];
    if (rows.length < 2) {
      process.stderr.write('   (empty)\n');
      continue;
    }
    const pos = {};
    rows[0].forEach((h, i) => (pos[norm(h)] = i));
    const source = `egov:annexes:${ds.year}:${ds.variant}`;
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
    process.stderr.write(`   ${count.toLocaleString('en-US')} amendments\n`);
  }

  out.end();
  await once(out, 'finish');
  process.stderr.write(
    `==> wrote ${grand.toLocaleString('en-US')} rows → ${outFile} (largest statement ${maxStmtBytes.toLocaleString('en-US')} bytes)\n`,
  );

  if (!apply) {
    process.stderr.write(
      `\nNext: load it, then derive:\n` +
        `  (cd apps/api && wrangler d1 execute sigma --local --file ${outFile})\n` +
        `  (cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/derive-amendments.sql)\n`,
    );
    return;
  }
  const scope = remote ? '--remote' : '--local';
  const runW = (a) => {
    process.stderr.write(`==> wrangler ${a.join(' ')}\n`);
    execFileSync('wrangler', a, { stdio: 'inherit', cwd: apiDir });
  };
  runW(['d1', 'migrations', 'apply', 'sigma', scope]);
  runW(['d1', 'execute', 'sigma', scope, '--file', outFile]);
  process.stderr.write(
    `\n==> loaded: ${JSON.stringify(perDataset)} — now run scripts/derive-amendments.sql\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
