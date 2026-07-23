// TR name-uniqueness census (ADR-0015). Promotes tier-C held interest_links — generic company names
// with a single WINNER namesake — to 'published' iff the name is GLOBALLY unique in the Trade Register.
//
// Source: the Commercial Register open-data dump on data.egov.bg (DPA-safe: ЕГН/ЛНЧ hashed out, company
// name + ЕИК retained). We build companyNameKey(name) → {distinct ЕИК} over ALL active entities using
// the SAME normalizer as the matcher, so the key spaces are identical. Promotion is deterministic:
// key count == 1 AND that ЕИК == the matched winner ЕИК. Anything else stays held. No heuristic.
//
// Field-detection is structural (find the 9/13-digit ЕИК; find the company-name field), so it is robust
// to the exact open-data column names — confirm the mapping against the real dump before a production run.
//
// Run: node --import ./scripts/cacbg/register-ts.mjs scripts/cacbg/tr-census.mjs --dump <path.json|.jsonl>
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = process.env.CACBG_DB || path.join(ROOT, 'data/work/backfill.sqlite');
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DUMP = arg('dump') || process.env.TR_DUMP;
const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

const isEik = (v) => typeof v === 'string' && /^\d{9}$|^\d{13}$/.test(v.trim());

// The register stores CompanyName WITHOUT the legal form and LegalForm as a code; our matcher keys on the
// name WITH its Bulgarian form (bidders.name = «…» ЕООД), so we must reconstruct it or every lookup misses.
// Codes seen in the real dump: EOOD OOD ASSOC CC K EAD ET AD KCHT FOUND KD SD DPK EDPK IAD IEAD.
const LEGAL_FORM = {
  EOOD: 'ЕООД',
  OOD: 'ООД',
  EAD: 'ЕАД',
  AD: 'АД',
  ET: 'ЕТ',
  KD: 'КД',
  K: 'КД',
  SD: 'СД',
  KCHT: 'КДА',
  IAD: 'ИАД',
  IEAD: 'ИЕАД',
  DPK: 'ПК',
  EDPK: 'ЕПК',
  CC: 'кооперация',
  ASSOC: 'СНЦ',
  FOUND: 'фондация',
};
// A Bulgarian trade name reconstructed to match the matcher's key space. Unknown form → append the raw
// code (harmless: it just forms its own key that no bidder lookup will hit).
const bgName = (companyName, legalForm) =>
  `${String(companyName ?? '').trim()} ${LEGAL_FORM[legalForm] ?? String(legalForm ?? '').trim()}`.trim();

// Extract {eik, name} from ONE TR deed's attribute object ({CompanyName, LegalForm, UIC, DeedStatus, …}).
// Also tolerates a flat {eik/uic, name} record (test fixtures). ЕИК = the 9/13-digit UIC.
export function extractEntity(rec) {
  const uic = rec.UIC ?? rec.uic ?? rec.eik ?? rec.EIK;
  const eik = isEik(String(uic ?? '')) ? String(uic).trim() : null;
  const name =
    rec.CompanyName != null ? bgName(rec.CompanyName, rec.LegalForm) : (rec.name ?? null);
  return { eik, name: name || null };
}

// Read a TR dump as deed-attribute records. The real data.egov.bg export nests them at
// Message[].Body[].Deeds[].Deed[], each carrying its fields under `$` (fast-xml/attr style). Falls back to
// a plain JSON array / {data:[…]} / JSONL of already-flat records so tests and other shapes still work.
function* records(dump) {
  const raw = fs.readFileSync(dump, 'utf8');
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(raw);
    const deeds = parsed?.Message?.[0]?.Body?.[0]?.Deeds?.[0]?.Deed;
    if (Array.isArray(deeds)) {
      for (const d of deeds) yield d?.['$'] ?? d;
      return;
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed.data ?? parsed.records ?? parsed.result ?? []);
    yield* arr;
  } else {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t) yield JSON.parse(t);
    }
  }
}

// Build companyNameKey → Set(ЕИК) over one or more dump files (accumulates — call with every daily file to
// approach the full register). Deduped by ЕИК within a key, so the same company appearing on many days
// (or a name→one company) counts once; two DISTINCT companies sharing a name yield size>1 = not unique.
export function buildCensus(dumps) {
  const census = new Map();
  for (const dump of Array.isArray(dumps) ? dumps : [dumps]) {
    for (const rec of records(dump)) {
      const { eik, name } = extractEntity(rec);
      if (!eik || !name) continue;
      const key = companyNameKey(name);
      if (!census.has(key)) census.set(key, new Set());
      census.get(key).add(eik);
    }
  }
  return census;
}

// Promote held tier-C links the census proves globally unique: name-key maps to EXACTLY one ЕИК AND that
// ЕИК is the matched winner's (a national namesake, even at a different ЕИК, keeps the link held). With
// dryRun, report the would-promote set without writing — used to validate against a PARTIAL census, which
// must never actually promote (an un-ingested namesake would make a false-unique claim = libel).
export function promote(db, census, { dryRun = false, minEik = null, forcePartial = false } = {}) {
  // Partial-census guard (libel gate). A census smaller than the real ТР register can make a genuinely
  // non-unique name look unique (`eiks.size === 1`) → a false, libelous attribution. A real promote must
  // ASSERT coverage in code, not by convention: pass `--min-eik ≥ register size` (the census's distinct-ЕИК
  // count must meet it) or the explicit `--force-partial` escape hatch. dryRun is exempt — it writes nothing
  // and exists precisely to inspect a partial census.
  if (!dryRun && !forcePartial) {
    if (!Number.isInteger(minEik) || minEik < 1) {
      throw new Error(
        'refusing to promote without --min-eik <register size>: a partial census silently fabricates ' +
          'false-unique attributions. Pass --min-eik ≥ the known ТР register size, or --force-partial to override.',
      );
    }
    const distinctEik = new Set();
    for (const s of census.values()) for (const e of s) distinctEik.add(e);
    if (distinctEik.size < minEik) {
      throw new Error(
        `refusing to promote from a partial census: ${distinctEik.size} distinct ЕИК < --min-eik ${minEik}. ` +
          'Ingest more ТР dumps until coverage meets the register size, or pass --force-partial to override.',
      );
    }
  }
  const held = db
    .prepare(
      "SELECT link_key, eik, entity_key FROM interest_links WHERE status='held' AND publish_tier='C_hold'",
    )
    .all();
  const upd = db.prepare(
    "UPDATE interest_links SET status='published', match_method='exact_name_key+tr_census' WHERE link_key=?",
  );
  const would = [];
  if (!dryRun) db.exec('BEGIN');
  for (const l of held) {
    const eiks = census.get(l.entity_key);
    if (eiks && eiks.size === 1 && eiks.has(l.eik)) {
      would.push(l.link_key);
      if (!dryRun) upd.run(l.link_key);
    }
  }
  if (!dryRun) db.exec('COMMIT');
  return { promoted: would.length, stillHeld: held.length - would.length, would };
}

// Resolve --dump: a single file, a comma-list, or --dump-dir <dir> (every *.json/*.jsonl inside).
function dumpFiles() {
  const dir = arg('dump-dir');
  if (dir)
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(json|jsonl)$/.test(f))
      .map((f) => path.join(dir, f));
  return DUMP
    ? DUMP.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

// CLI entry (guarded so importing this module in tests has no side effects)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const files = dumpFiles();
  const dryRun = process.argv.includes('--dry-run');
  const forcePartial = process.argv.includes('--force-partial');
  const minEik = arg('min-eik') !== undefined ? Number(arg('min-eik')) : null;
  if (!files.length) {
    console.log(
      'no --dump/--dump-dir provided; census not run. Provide TR open-data files to promote tier-C links.',
    );
  } else {
    const db = new DatabaseSync(DB);
    const census = buildCensus(files);
    const eikTotal = [...census.values()].reduce((n, s) => n + s.size, 0);
    console.log(
      `census: ${files.length} file(s) → ${census.size} distinct name-keys / ${eikTotal} ЕИК`,
    );
    const { promoted, stillHeld, would } = promote(db, census, { dryRun, minEik, forcePartial });
    console.log(
      `${dryRun ? 'DRY-RUN would promote' : 'tier-C promotions'}: ${promoted} published, ${stillHeld} still held (non-unique or namesake mismatch)`,
    );
    if (dryRun && would.length)
      console.log('  would-promote link_keys:\n   ' + would.join('\n   '));
    db.close();
  }
}
