#!/usr/bin/env node
// Load the Търговски регистър (Trade Register, Агенция по вписванията) open data from data.egov.bg
// (dataset 2df0c2af-e769-4397-be33-fcbe269806f3) — daily XML deltas, one resource per day, "с
// включена история и заличени лични данни" (personal IDs hashed). Each <Deed> is a company's current
// state (by ЕИК) with seat address (+ ЕКАТТЕ).
//
//   node scripts/load-tr.mjs                 # list recent daily resources
//   node scripts/load-tr.mjs --limit=25      # parse the 25 most-recent days → data/tr-*-load.sql
//   node scripts/load-tr.mjs --limit=25 --apply   # also migrate + load local D1
//
//   flags: --limit=N (default 25; the open feed is daily deltas, so a backfill is a window — the
//          scheduled apps/etl job accumulates the rest day by day), --apply, --remote, --refresh
//
// Wipes are scoped to source 'tr:%'.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const cacheDir = resolve(root, 'data/tr');
const API = 'https://data.egov.bg/api';
const TR_DATASET = '2df0c2af-e769-4397-be33-fcbe269806f3';
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

const COMPANY_COLS = [
  'source',
  'fetched_at',
  'file_date',
  'deed_guid',
  'uic',
  'company_name',
  'legal_form',
  'deed_status',
  'subject_of_activity',
  'nkid',
  'country',
  'district',
  'district_ekatte',
  'municipality',
  'municipality_ekatte',
  'settlement',
  'settlement_ekatte',
  'post_code',
  'street',
  'street_number',
];

const sqlLit = (v) =>
  v === null || v === undefined || v === ''
    ? 'NULL'
    : `'${String(v)
        .replace(/[\x00-\x1F]/g, '')
        .replace(/'/g, "''")}'`;
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const txt = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']).trim() || null : null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
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
function cachePath(resourceUri) {
  const safeUri = String(resourceUri);
  if (!/^[A-Za-z0-9_.-]+$/.test(safeUri)) throw new Error(`invalid resource_uri: ${resourceUri}`);
  const file = resolve(cacheDir, `${safeUri}.xml`);
  const rel = relative(cacheDir, file);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`${sep}`)) {
    throw new Error(`resource_uri escapes cache dir: ${resourceUri}`);
  }
  return file;
}
async function downloadXml(resourceUri, refresh) {
  const cacheFile = cachePath(resourceUri);
  if (!refresh && existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');
  const resp = await fetch(`https://data.egov.bg/resource/download/${resourceUri}/xml`);
  if (!resp.ok) throw new Error(`download ${resourceUri}: HTTP ${resp.status}`);
  const text = await resp.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, text);
  return text;
}
// Resource name → ISO date. Handles the daily-file variants seen in the feed:
// "Търговски регистър DD.MM.YYYY", odd dots/spaces ("05..10.2024", "12.12 2023"), and the
// earliest ISO-named files ("20220901"). Returns null if no date is recoverable.
function dateFromName(name) {
  const s = String(name || '');
  let m = s.match(/\b(20\d{2})(\d{2})(\d{2})\b/); // ISO YYYYMMDD (e.g. 20220901)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[.\s]+(\d{1,2})[.\s]+(\d{4})/); // DD.MM.YYYY tolerating extra dots/spaces
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
async function discover(limit, all) {
  const out = [];
  for (let page = 1; (all || out.length < limit) && page <= 60; page++) {
    const r = await postJSON('listResources', {
      criteria: { dataset_uri: TR_DATASET },
      records_per_page: 50,
      page_number: page,
    });
    const rs = r.resources || [];
    if (!rs.length) break;
    for (const x of rs) out.push({ uri: x.uri, name: x.name, date: dateFromName(x.name) });
    if (rs.length < 50) break;
  }
  const sorted = out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return all ? sorted : sorted.slice(0, limit);
}

function deedToRows(deed, ctx) {
  const uic = deed['@_UIC'] || null;
  if (!uic) return null;
  const subs = asArray(deed.SubDeed);
  let addr = null;
  let subject = null;
  let nkid = null;
  for (const s of subs) {
    if (!addr && s?.Seat?.Address) addr = s.Seat.Address;
    if (!subject && s?.SubjectOfActivity != null) subject = txt(s.SubjectOfActivity);
    if (!nkid && s?.SubjectOfActivityNKID != null) nkid = txt(s.SubjectOfActivityNKID);
  }
  const company = {
    source: ctx.source,
    fetched_at: ctx.fetchedAt,
    file_date: ctx.fileDate,
    deed_guid: deed['@_GUID'] || null,
    uic,
    company_name: deed['@_CompanyName'] || null,
    legal_form: deed['@_LegalForm'] || null,
    deed_status: deed['@_DeedStatus'] || null,
    subject_of_activity: subject,
    nkid,
    country: addr ? txt(addr.Country) : null,
    district: addr ? txt(addr.District) : null,
    district_ekatte: addr ? txt(addr.DistrictEkatte) : null,
    municipality: addr ? txt(addr.Municipality) : null,
    municipality_ekatte: addr ? txt(addr.MunicipalityEkatte) : null,
    settlement: addr ? txt(addr.Settlement) : null,
    settlement_ekatte: addr ? txt(addr.SettlementEKATTE) : null,
    post_code: addr ? txt(addr.PostCode) : null,
    street: addr ? txt(addr.Street) : null,
    street_number: addr ? txt(addr.StreetNumber) : null,
  };
  return { company };
}

async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}
function makeBatcher(out, header) {
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let batch = [];
  let stmtBytes = headerBytes;
  const flush = async () => {
    if (!batch.length) return;
    await writeChunk(out, header + batch.join(',\n') + ';\n');
    batch = [];
    stmtBytes = headerBytes;
  };
  const push = async (tuple) => {
    const tb = Buffer.byteLength(tuple, 'utf8') + 2;
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES))
      await flush();
    batch.push(tuple);
    stmtBytes += tb;
  };
  return { push, flush };
}

async function main() {
  const all = !!arg('all');
  const limit = arg('limit') ? Number(arg('limit')) : 25;
  const chunkSize = arg('chunk') ? Number(arg('chunk')) : all ? 40 : Math.max(limit, 1);
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const refresh = !!arg('refresh');

  process.stderr.write('==> discovering Trade Register daily resources…\n');
  const resources = await discover(limit, all);
  if (!arg('limit') && !all && !apply) {
    process.stderr.write(`\nMost-recent ${resources.length} daily resources:\n`);
    for (const r of resources.slice(0, 25)) process.stderr.write(`  ${r.date}  ${r.uri}\n`);
    process.stderr.write(
      '\nScope: --limit=N or --all  (+ --apply to load D1). Open feed is daily deltas from 2022-09.\n',
    );
    return;
  }
  process.stderr.write(
    `==> processing ${resources.length} daily files in chunks of ${chunkSize} (deltas)\n`,
  );

  const files = {
    companies: resolve(root, 'data/tr-companies-load.sql'),
  };
  const scope = remote ? '--remote' : '--local';
  const runW = (a) => {
    process.stderr.write(`==> wrangler ${a.join(' ')}\n`);
    execFileSync('wrangler', a, { stdio: 'inherit', cwd: apiDir });
  };
  if (apply) {
    runW(['d1', 'migrations', 'apply', 'sigma', scope]);
    // one-time clear of this source's staging (chunks below only INSERT, so they accumulate)
    const clear = resolve(root, 'data/tr-clear.sql');
    writeFileSync(clear, "DELETE FROM raw_tr_companies WHERE source LIKE 'tr:%';\n");
    runW(['d1', 'execute', 'sigma', scope, '--file', clear]);
  }

  // Keep everything as strings — coercion would strip leading zeros from ЕКАТТЕ / ЕИК / post codes.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
  let nDeeds = 0;
  const chunks = Math.ceil(resources.length / chunkSize) || 1;
  writeFileSync(files.companies, '');
  const cOut = createWriteStream(files.companies, { encoding: 'utf8', flags: 'a' });
  await writeChunk(cOut, '-- Generated by scripts/load-tr.mjs (chunks).\n');
  const cb = makeBatcher(
    cOut,
    `INSERT INTO raw_tr_companies (${COMPANY_COLS.join(', ')}) VALUES\n`,
  );

  try {
    for (let i = 0; i < resources.length; i += chunkSize) {
      const chunk = resources.slice(i, i + chunkSize);
      for (const res of chunk) {
        const ctx = { source: `tr:${res.date}`, fetchedAt, fileDate: res.date };
        let xml;
        try {
          xml = await downloadXml(res.uri, refresh);
        } catch (e) {
          process.stderr.write(`!! ${res.date || res.uri}: ${e.message} — skipping\n`);
          continue;
        }
        let deeds;
        try {
          const doc = parser.parse(xml);
          const body = doc.Message?.Body || doc.Body || doc;
          deeds = asArray((body.Deeds || body).Deed);
        } catch (e) {
          process.stderr.write(`!! ${res.date || res.uri}: parse error ${e.message} — skipping\n`);
          continue;
        }
        for (const deed of deeds) {
          const rows = deedToRows(deed, ctx);
          if (!rows) continue;
          await cb.push(`(${COMPANY_COLS.map((c) => sqlLit(rows.company[c])).join(',')})`);
          nDeeds++;
        }
      }
      await cb.flush();
      process.stderr.write(
        `==> chunk ${Math.floor(i / chunkSize) + 1}/${chunks} — cumulative ${nDeeds.toLocaleString('en-US')} ` +
          `company rows\n`,
      );
    }
  } finally {
    cOut.end();
    await once(cOut, 'finish');
  }
  if (apply)
    for (const f of Object.values(files)) runW(['d1', 'execute', 'sigma', scope, '--file', f]);

  process.stderr.write(
    `\n==> done: ${nDeeds.toLocaleString('en-US')} company rows from ${resources.length} files\n`,
  );
  if (!apply)
    process.stderr.write('(dry run — SQL written to data/tr-*-load.sql; re-run with --apply)\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
