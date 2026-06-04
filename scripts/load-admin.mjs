#!/usr/bin/env node
// Load the admin ЦАИС ЕОП export (data/Open_data_resources.zip) — the rich, authoritative
// source for 2020–2026. Contracts/Tenders/Annexes per year, each a CSV inside a nested zip.
// Contracts already carry procedure type / CPV / estimated value / lots / authority type /
// consortium flag, so rows land with needs_enrichment = 0 — no separate enrichment pass.
//
//   node scripts/load-admin.mjs                    # parse all → data/admin-*-load.sql
//   node scripts/load-admin.mjs --apply            # also migrate + load local D1
//   node scripts/load-admin.mjs --cat=contracts --year=2023   # one slice
//
//   flags: --cat=contracts|tenders|annexes (default all), --year=YYYY (default all),
//          --apply, --remote
//
// Format notes (differ from the portal feed): comma decimals (69999,00), dot dates
// (05.10.2021), Да/Не booleans, comma-delimited CSV with quoted fields → parsed with
// SheetJS and mapped BY HEADER NAME (indices shift due to embedded commas). Wipes are
// scoped to source 'admin:<cat>:%'.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const zipFile = resolve(root, 'data/Open_data_resources.zip');
const workDir = resolve(root, 'data/admin-export'); // gitignored scratch
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toInt(v) {
  const s = clean(v);
  if (s === null) return null;
  const n = parseInt(s.replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// European numbers: comma decimal, optional dot/space thousands.
function toReal(v) {
  let s = clean(v);
  if (s === null) return null;
  s = s.replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (['да', 'true', '1', 'yes'].includes(t)) return 1;
  if (['не', 'false', '0', 'no'].includes(t)) return 0;
  return null;
}
// DD.MM.YYYY or DD/MM/YYYY (single digits + trailing " г."/time tolerated) → ISO.
function toISODate(v) {
  const s = clean(v);
  if (s === null) return null;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}
function coerce(kind, v) {
  if (kind === 'int') return toInt(v);
  if (kind === 'real') return toReal(v);
  if (kind === 'bool') return toBool(v);
  if (kind === 'date') return toISODate(v);
  return clean(v);
}
function lit(kind, value) {
  if (value === null) return 'NULL';
  if (kind === 'int' || kind === 'real' || kind === 'bool') return String(value);
  return `'${String(value)
    .replace(/[\x00-\x1F]/g, '')
    .replace(/'/g, "''")}'`;
}
function readSheetInput(file) {
  const buf = readFileSync(file);
  if (/\.xlsx$/i.test(file)) {
    if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`invalid .xlsx input ${file}: missing ZIP magic`);
    }
    return { data: buf, type: 'buffer' };
  }
  if (buf.length > 0 && buf[0] === 0x3c) {
    throw new Error(`invalid spreadsheet input ${file}: XML-like content is not accepted`);
  }
  return { data: buf.toString('utf8'), type: 'string' };
}

// Per category: target table, fixed columns (+ values fn), and [field, header, kind] map.
const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
const CATS = {
  contracts: {
    dir: 'Contracts',
    table: 'raw_egov_contracts',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at', 'needs_enrichment'],
    fixedVals: (y) => [`'admin:contracts:${y}'`, String(y), `'admin'`, `'${fetchedAt}'`, '0'],
    keep: (get) => get('Номер на договор') !== null, // only rows with a signed contract
    // Full capture: every Contracts CSV header (57 cols) lands in staging; the domain promotes a subset.
    fields: [
      ['seq_no', 'Пореден номер', 'text'],
      ['document_number', 'Номер на документ', 'text'],
      ['published_at', 'Дата на публикуване', 'date'],
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['tender_ext_id', 'ID на поръчката', 'text'],
      ['procedure_type', 'Вид на поръчката', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['cpv_code', 'Основен CPV код', 'text'],
      ['cpv_description', 'Описание на CPV кода', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['estimated_value', 'Прогнозна стойност', 'real'],
      ['procurement_currency', 'Валута на поръчката', 'text'],
      ['legal_basis', 'Правно основание за откриване на поръчката', 'text'],
      ['award_criteria', 'Критерий за възлагане', 'text'],
      ['joint_procurement', 'Съвместно възлагане', 'bool'],
      ['central_purchasing', 'Поръчката е възложена от централен орган за покупки', 'bool'],
      ['authority_name', 'Възложител', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_type', 'Вид на възложителя', 'text'],
      ['main_activity', 'Основна дейност', 'text'],
      ['notice_type', 'Вид обявление', 'text'],
      ['lot_id', 'Идентификатор на обособена позиция', 'text'],
      ['contract_number', 'Номер на договор', 'text'],
      ['contract_date', 'Дата на договор', 'date'],
      ['signing_value', 'Стойност при сключване', 'real'],
      ['currency', 'Валута', 'text'],
      ['contract_subject', 'Предмет на договора', 'text'],
      ['awarded_to_group', 'Възложена на група от икономически оператори', 'bool'],
      ['contractor_eik', 'ЕИК на изпълнителя', 'text'],
      ['contractor_name', 'Изпълнител', 'text'],
      ['contractor_country', 'Код на държавата на изпълнителя', 'text'],
      ['winner_owner_nationality', 'Националност на собственика на победителя', 'text'],
      ['winner_size', 'Размер на победителя', 'text'],
      ['has_subcontractor', 'Подизпълнител', 'bool'],
      ['subcontractor_name', 'Наименование на подизпълнителя', 'text'],
      ['subcontractor_eik', 'ЕИК на подизпълнителя', 'text'],
      ['subcontract_share', 'Дял на поръчката, възложен на подизпълнител', 'text'],
      ['subcontract_value', 'Стойност, възложена на подизпълнител', 'real'],
      ['eu_funded', 'EU финансиране', 'bool'],
      ['eu_programme', 'Европейска програма', 'text'],
      ['framework_notice', 'Поръчка за Рамково споразумение', 'bool'],
      ['framework_contract', 'Договор по рамково споразумение', 'bool'],
      ['related_to', 'Свързана с', 'text'],
      ['dps_contract', 'Договор по ДСП', 'bool'],
      ['accelerated', 'Ускорена', 'bool'],
      ['eauction', 'Електронен търг', 'bool'],
      ['strategic', 'Стратегическа поръчка', 'bool'],
      ['outside_zop', 'Договорът е извън приложното поле на ЗОП', 'bool'],
      ['exemption_legal_basis', 'Правно основание за изключение', 'text'],
      ['bids_received', 'Брой оферти', 'int'],
      ['bids_sme', 'Брой оферти от МСП', 'int'],
      ['bids_rejected', 'Брой отстранени оферти', 'int'],
      ['bids_non_eea', 'Брой оферти - извън ЕИП', 'int'],
      ['duration_days', 'Срок на договора в дни', 'int'],
      ['non_award', 'Невъзлагане', 'bool'],
      ['correction_number', 'Номер на поправката', 'text'],
      ['ted_link', 'Линк към публикацията в ТЕД', 'text'],
    ],
  },
  tenders: {
    dir: 'Tenders',
    table: 'raw_egov_tenders',
    fixed: ['source', 'dataset_year', 'fetched_at'],
    fixedVals: (y) => [`'admin:tenders:${y}'`, String(y), `'${fetchedAt}'`],
    keep: () => true,
    // Full capture: every Tenders CSV header (52 cols).
    fields: [
      ['seq_no', 'Пореден номер', 'text'],
      ['document_number', 'Номер на документ', 'text'],
      ['published_at', 'Дата на публикуване', 'date'],
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['tender_id', 'ID на поръчката', 'text'],
      ['procedure_type', 'Вид на поръчката', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['cpv_code', 'Основен CPV код', 'text'],
      ['cpv_description', 'Описание на CPV кода', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['estimated_value', 'Прогнозна стойност', 'real'],
      ['currency', 'Валута на поръчката', 'text'],
      ['legal_basis', 'Правно основание за откриване на поръчката', 'text'],
      ['award_criteria', 'Критерий за възлагане', 'text'],
      ['joint_procurement', 'Съвместно възлагане', 'bool'],
      ['central_purchasing', 'Поръчката е възложена от централен орган за покупки', 'bool'],
      ['authority_name', 'Възложител', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_type', 'Вид на възложителя', 'text'],
      ['main_activity', 'Основна дейност', 'text'],
      ['deadline', 'Срок за получаване на оферти', 'text'],
      ['notice_type', 'Вид обявление', 'text'],
      ['lot_id', 'Идентификатор на обособена позиция', 'text'],
      ['eu_funded', 'EU финансиране', 'bool'],
      ['eu_programme', 'Европейска програма', 'text'],
      ['secured_financing', 'Осигурено финансиране', 'bool'],
      ['framework_notice', 'Поръчка за Рамково споразумение', 'bool'],
      ['dps_notice', 'Поръчка за ДСП', 'bool'],
      ['accelerated', 'Ускорена', 'bool'],
      ['eauction', 'Електронен търг', 'bool'],
      ['strategic', 'Стратегическа поръчка', 'bool'],
      ['green', 'Екологосъобразна поръчка', 'bool'],
      ['social', 'Постигане на социални цели', 'bool'],
      ['innovation', 'Поръчка за новаторски решения', 'bool'],
      ['options', 'Опции', 'bool'],
      ['renewable', 'Подлежи на подновяване', 'bool'],
      ['reserved', 'Запазено участие', 'bool'],
      ['variants', 'Варианти на оферти', 'bool'],
      ['num_lots', 'Брой обособени позиции', 'int'],
      ['place_of_performance', 'Място на изпълнение', 'text'],
      ['lot_name', 'Наименование на обособената позиция', 'text'],
      ['duration', 'Продължителност', 'text'],
      ['duration_unit', 'Продължителност - мерна единица', 'text'],
      ['start_date', 'Начална дата', 'date'],
      ['end_date', 'Крайна дата', 'date'],
      ['einvoicing', 'Електронно фактуриране', 'bool'],
      ['epayment', 'Електронно плащане', 'bool'],
      ['eordering', 'Електронно поръчване', 'bool'],
      ['corrections_count', 'Брой поправки на обявлението за откриване на поръчката', 'int'],
      ['cancelled', 'Отменена', 'bool'],
      ['correction_number', 'Номер на поправката', 'text'],
      ['ted_link', 'Линк към публикацията в ТЕД', 'text'],
    ],
  },
  annexes: {
    dir: 'Annexes',
    table: 'raw_egov_amendments',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at'],
    fixedVals: (y) => [`'admin:annexes:${y}'`, String(y), `'admin'`, `'${fetchedAt}'`],
    keep: (get) => get('Номер на договор') !== null,
    // Full capture: every Annexes CSV header (37 cols).
    fields: [
      ['seq_no', 'Пореден номер', 'text'],
      ['document_number', 'Номер на документ', 'text'],
      ['published_at', 'Дата на публикуване', 'date'],
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['tender_ext_id', 'ID на поръчката', 'text'],
      ['procedure_type', 'Вид на поръчката', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['cpv_code', 'Основен CPV код', 'text'],
      ['cpv_description', 'Описание на CPV кода', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['authority_name', 'Възложител', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_type', 'Вид на възложителя', 'text'],
      ['main_activity', 'Основна дейност', 'text'],
      ['lot_id', 'Идентификатор на обособена позиция', 'text'],
      ['contract_number', 'Номер на договор', 'text'],
      ['contract_date', 'Дата на договор', 'date'],
      ['value_before', 'Стойност преди изменението', 'real'],
      ['value_after', 'Стойност след изменението', 'real'],
      ['value_delta', 'Изменение', 'real'],
      ['currency', 'Валута', 'text'],
      ['contract_subject', 'Предмет на договора', 'text'],
      ['awarded_to_group', 'Възложена на група от икономически оператори', 'bool'],
      ['contractor_eik', 'ЕИК на изпълнителя', 'text'],
      ['contractor_name', 'Изпълнител', 'text'],
      ['contractor_country', 'Код на държавата на изпълнителя', 'text'],
      ['winner_owner_nationality', 'Националност на собственика на победителя', 'text'],
      ['winner_size', 'Размер на победителя', 'text'],
      ['eu_funded', 'EU финансиране', 'bool'],
      ['eu_programme', 'Европейска програма', 'text'],
      ['description', 'Описание на измененията', 'text'],
      ['reason', 'Причини за изменение', 'text'],
      ['circumstances', 'Обстоятелства', 'text'],
      ['outside_zop', 'Договорът е извън приложното поле на ЗОП', 'bool'],
      ['exemption_legal_basis', 'Правно основание за изключение', 'text'],
      ['correction_number', 'Номер на поправката', 'text'],
      ['ted_link', 'Линк към публикацията в ТЕД', 'text'],
    ],
  },
};

function extractCsv(cat, year) {
  const cfg = CATS[cat];
  const innerZip = `OpenData_${cfg.dir}_${year}.zip`;
  const tmp = resolve(workDir, `${cat}_${year}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync(
    'unzip',
    ['-o', '-j', zipFile, `Open_data_resources/${cfg.dir}/${innerZip}`, '-d', tmp],
    {
      stdio: 'ignore',
    },
  );
  execFileSync('unzip', ['-o', '-j', resolve(tmp, innerZip), '-d', tmp], { stdio: 'ignore' });
  return { csv: resolve(tmp, `OpenData_${cfg.dir}.csv`), tmp };
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

async function loadCategory(cat, years, apply, remote) {
  const cfg = CATS[cat];
  const insertCols = [...cfg.fixed, ...cfg.fields.map((f) => f[0])];
  const outFile = resolve(root, `data/admin-${cat}-load.sql`);
  const out = createWriteStream(outFile, { encoding: 'utf8' });
  await writeChunk(
    out,
    `-- Generated by scripts/load-admin.mjs — do not edit by hand.\n` +
      `DELETE FROM ${cfg.table} WHERE source LIKE 'admin:${cat}:%';\n`,
  );
  const header = `INSERT INTO ${cfg.table} (${insertCols.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let grand = 0;
  let maxStmt = 0;

  for (const year of years) {
    let csvPath, tmp;
    try {
      ({ csv: csvPath, tmp } = extractCsv(cat, year));
    } catch {
      process.stderr.write(`!! ${cat} ${year}: no inner zip — skipping\n`);
      continue;
    }
    if (!existsSync(csvPath)) {
      process.stderr.write(`!! ${cat} ${year}: CSV missing after extract — skipping\n`);
      continue;
    }
    process.stderr.write(`==> ${cat} ${year}: parsing\n`);
    const sheetInput = readSheetInput(csvPath);
    const wb = XLSX.read(sheetInput.data, { type: sheetInput.type, raw: true, dense: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    rmSync(tmp, { recursive: true, force: true }); // keep disk low

    const pos = {};
    (rows[0] || []).forEach((h, i) => (pos[norm(h)] = i));
    const idxOf = (alias) => pos[norm(alias)];
    const fixedVals = cfg.fixedVals(year);

    let batch = [];
    let stmtBytes = headerBytes;
    let count = 0;
    const flush = async () => {
      if (!batch.length) return;
      const stmt = header + batch.join(',\n') + ';\n';
      maxStmt = Math.max(maxStmt, Buffer.byteLength(stmt, 'utf8'));
      await writeChunk(out, stmt);
      batch = [];
      stmtBytes = headerBytes;
    };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (alias) => {
        const i = idxOf(alias);
        return i === undefined ? null : clean(row[i]);
      };
      if (!cfg.keep(get)) continue;
      const vals = [...fixedVals];
      for (const [, headerName, kind] of cfg.fields) {
        const i = idxOf(headerName);
        vals.push(lit(kind, i === undefined ? null : coerce(kind, row[i])));
      }
      const tuple = `(${vals.join(',')})`;
      const tb = Buffer.byteLength(tuple, 'utf8') + 2;
      if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES))
        await flush();
      batch.push(tuple);
      stmtBytes += tb;
      count++;
    }
    await flush();
    grand += count;
    process.stderr.write(`   ${count.toLocaleString('en-US')} rows\n`);
  }

  out.end();
  await once(out, 'finish');
  process.stderr.write(
    `==> ${cat}: ${grand.toLocaleString('en-US')} rows → ${outFile} (max stmt ${maxStmt})\n`,
  );

  if (apply) {
    const scope = remote ? '--remote' : '--local';
    execFileSync('wrangler', ['d1', 'execute', 'sigma', scope, '--file', outFile], {
      stdio: 'inherit',
      cwd: apiDir,
    });
  }
  return grand;
}

async function main() {
  const cats = arg('cat') ? [arg('cat')] : ['contracts', 'tenders', 'annexes'];
  const years = arg('year') ? [Number(arg('year'))] : YEARS;
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  if (!existsSync(zipFile)) throw new Error(`missing ${zipFile}`);

  if (apply) {
    const scope = remote ? '--remote' : '--local';
    execFileSync('wrangler', ['d1', 'migrations', 'apply', 'sigma', scope], {
      stdio: 'inherit',
      cwd: apiDir,
    });
  }
  const totals = {};
  for (const cat of cats) totals[cat] = await loadCategory(cat, years, apply, remote);
  process.stderr.write(`\n==> done: ${JSON.stringify(totals)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
