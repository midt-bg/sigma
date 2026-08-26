// Extract structured staging from the raw CACBG cache (re-runnable; no network).
// Reads scratch/cacbg/raw/<year>/{list.xml, *.xml}, parses both declaration templates, and writes:
//   • staging/holdings.jsonl  — company-bearing declared interests (shares/participation/management/
//                               sole_trader). PUBLIC data (official + company). This feeds the matcher.
//   • staging/related.jsonl   — declared THIRD-PARTY people (related-persons / conflict-contracts).
//                               PII → INTERNAL only (§8); git-ignored, never published as-is.
// PII rails: addresses/passport/phone are never extracted (parse.mjs); a non-empty EGN is counted, not stored.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseList, parseDeclaration } from './parse.mjs';
import { assertScratchIgnored, assertOverrideDirSafe, SCRATCH } from './guard.mjs';
import { sentinelPath } from './fetch.mjs';

// Overridable for tests, mirroring load.mjs's CACBG_DB/CACBG_STAGING. Defaults are the real scratch, so
// production behaviour is unchanged when they are unset.
const RAW = process.env.CACBG_RAW || path.join(SCRATCH, 'raw');
const STAGING = process.env.CACBG_STAGING || path.join(SCRATCH, 'staging');
// Validate the ACTUAL output directories, default or overridden alike (review round 5, blocker 2):
// assertScratchIgnored probes only the fixed scratch/cacbg/.probe path, so a symlink AT the sibling
// default `raw`/`staging` — or an overridden one — is invisible to it while fetch/extract I/O follows
// it into committable files. assertOverrideDirSafe canonicalizes the real target and asks git, so it
// is the right check for both. Unconditional: the default location must clear the same bar it guards.
assertOverrideDirSafe(RAW, process.env.CACBG_RAW ? 'CACBG_RAW' : 'scratch/cacbg/raw');
assertOverrideDirSafe(
  STAGING,
  process.env.CACBG_STAGING ? 'CACBG_STAGING' : 'scratch/cacbg/staging',
);

/**
 * Refuse a corpus that was never stamped complete — unless the caller states it knows.
 *
 * fetch.mjs writes `.corpus-complete.json` only when the crawl reconciles against the register's own
 * list.xml, and clears it before touching anything. So a missing stamp means one of: a deadline stop
 * (#313 made that an EXPECTED state), a crash, or a cache restored from a run that never finished.
 *
 * That distinction had no reader. `restore-keys: cacbg-raw-` takes the most RECENT snapshot, not the most
 * complete, and the loop below walks readdirSync over whatever files exist without reconciling them
 * against list.xml — so a truncated corpus simply produces a smaller surface, with no error anywhere.
 * Neither downstream gate closes it: the monotonicity gate sees net growth whenever new links outnumber
 * lost ones, the --min-links floor only counts, and a first run in a fresh environment has no baseline.
 *
 * A partial corpus stays fully usable for RESUMING — the next crawl skips what is on disk. This gate is
 * only about PUBLISHING from one.
 */
function assertCorpusComplete() {
  if (process.argv.includes('--allow-partial-corpus')) {
    console.warn(
      '⚠ --allow-partial-corpus: extracting from a corpus that was never stamped complete. ' +
        'Whatever is missing from the raw cache will be missing from the surface, silently.',
    );
    return;
  }
  if (fs.existsSync(sentinelPath(RAW))) return;
  throw new Error(
    `REFUSE TO EXTRACT: no completeness stamp at ${sentinelPath(RAW)}. The raw corpus was never ` +
      `confirmed whole — it is a deadline stop, a crashed crawl, or a cache restored from one. Extracting ` +
      `now would publish a surface missing whatever the corpus is missing, and nothing downstream would ` +
      `notice: the monotonicity gate sees net growth when new links offset lost ones, and the ship floor ` +
      `only counts. Re-run the crawl to completion (it resumes — declarations on disk are skipped), or ` +
      `pass --allow-partial-corpus to state that a smaller surface is intended.`,
  );
}

function run() {
  assertScratchIgnored();
  assertCorpusComplete();
  fs.mkdirSync(STAGING, { recursive: true });
  const holdingsOut = fs.createWriteStream(path.join(STAGING, 'holdings.jsonl'));
  const relatedOut = fs.createWriteStream(path.join(STAGING, 'related.jsonl'));
  // filings.jsonl — one record per DECLARATION (incl. empty / no-material ones that emit no holdings row).
  // The loader builds each person's latest-filing horizon from this to catch a divest-to-ZERO (B1, #226).
  const filingsOut = fs.createWriteStream(path.join(STAGING, 'filings.jsonl'));
  const stats = {
    decls: 0,
    assets: 0,
    interests: 0,
    unknown: 0,
    egnHits: 0,
    holdings: 0,
    related: 0,
    filings: 0,
    dupSkipped: 0,
    byKind: {},
  };

  // Same declaration is republished across sets (filing set + end-of-year *y + compliance nc/nonc). It
  // carries the SAME ControlHash (content hash) everywhere, so dedup globally by ControlHash — first
  // folder wins — or holdings/evidence double-count. A corrected re-filing has a DIFFERENT hash and is
  // legitimately kept (the loader aggregates per person→company). Bare-year/filing folders sort before
  // their *y republication, so the primary copy is the one retained.
  const seenHash = new Set();
  const folderRe = /^20\d{2}[A-Za-z0-9_]{0,8}$/;
  const folders = fs.existsSync(RAW)
    ? fs
        .readdirSync(RAW)
        .filter((f) => folderRe.test(f))
        .sort()
    : [];
  for (const folder of folders) {
    const dir = path.join(RAW, folder);
    const listPath = path.join(dir, 'list.xml');
    if (!fs.existsSync(listPath)) {
      console.log(`  ${folder}: no list.xml, skip`);
      continue;
    }
    // xmlFile → context (first listing wins; a person with multiple positions shares one filing)
    const ctx = new Map();
    for (const r of parseList(fs.readFileSync(listPath, 'utf8'))) {
      if (!ctx.has(r.xmlFile)) ctx.set(r.xmlFile, r);
    }
    let n = 0;
    for (const file of fs.readdirSync(dir)) {
      if (file === 'list.xml' || !file.endsWith('.xml')) continue;
      // A single malformed/truncated XML must not abort the whole corpus crawl — skip it and keep going,
      // counting the skip so a rise in skips is visible. (The crawl is a long polite fetch; losing it to
      // one bad file mid-run wastes hours.)
      let d;
      try {
        d = parseDeclaration(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (err) {
        stats.parseErrors = (stats.parseErrors ?? 0) + 1;
        console.warn(`  ! skipped ${folder}/${file}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (d.controlHash) {
        if (seenHash.has(d.controlHash)) {
          stats.dupSkipped++;
          continue;
        } // republished declaration
        seenHash.add(d.controlHash);
      }
      stats.decls++;
      stats[d.templateType] = (stats[d.templateType] ?? 0) + 1;
      if (d.egnPresent) stats.egnHits++;
      const c = ctx.get(file) ?? {};
      const person = c.person || d.declarant;
      // Emit the filing record UNCONDITIONALLY — before the interests loop — so a declaration with zero
      // material holdings (a divest-to-zero, an empty filing) still advances the person's horizon (B1).
      filingsOut.write(
        JSON.stringify({
          folder,
          xmlFile: file,
          year: d.year,
          template: d.templateType, // the divest horizon is compared PER declaration type (B1/#226)
          person,
          institution: c.institution ?? '',
        }) + '\n',
      );
      stats.filings++;
      for (const it of d.interests) {
        holdingsOut.write(
          JSON.stringify({
            folder,
            xmlFile: file,
            year: d.year,
            template: d.templateType,
            category: c.category ?? '',
            institution: c.institution ?? '',
            person,
            position: c.position ?? d.position ?? '',
            entity: it.entity,
            kind: it.kind,
            detail: it.detail,
            timing: it.timing,
            seat: it.seat ?? '',
            holderRelation: it.holderRelation ?? 'self',
            controlHash: d.controlHash,
          }) + '\n',
        );
        stats.holdings++;
        stats.byKind[it.kind] = (stats.byKind[it.kind] ?? 0) + 1;
      }
      for (const rp of d.relatedPersons) {
        relatedOut.write(
          JSON.stringify({
            folder,
            xmlFile: file,
            year: d.year,
            person,
            institution: c.institution ?? '',
            related_name: rp.name,
            related_kind: rp.kind,
            info: rp.info,
            timing: rp.timing,
          }) + '\n',
        );
        stats.related++;
      }
      n++;
    }
    console.log(`  ${folder}: ${n} declarations parsed`);
  }
  holdingsOut.end();
  relatedOut.end();
  filingsOut.end();
  console.log('\n=== extract summary ===');
  console.log(JSON.stringify(stats, null, 2));
}

// Only run when invoked directly — importing the module (e.g. a future unit test of a pure helper) must
// not trigger a real extraction pass over the raw cache. Matches the guard in fetch.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
