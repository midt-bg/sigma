// Extract structured staging from the raw CACBG cache (re-runnable; no network).
// Reads scratch/cacbg/raw/<year>/{list.xml, *.xml}, parses both declaration templates, and writes:
//   • staging/holdings.jsonl  — company-bearing declared interests (shares/participation/management/
//                               sole_trader). PUBLIC data (official + company). This feeds the matcher.
//   • staging/related.jsonl   — declared THIRD-PARTY people (related-persons / conflict-contracts).
//                               PII → INTERNAL only (§8); git-ignored, never published as-is.
// PII rails: addresses/passport/phone are never extracted (parse.mjs); a non-empty EGN is counted, not stored.

import fs from 'node:fs';
import path from 'node:path';
import { parseList, parseDeclaration } from './parse.mjs';
import { assertScratchIgnored, SCRATCH } from './guard.mjs';

const RAW = path.join(SCRATCH, 'raw');
const STAGING = path.join(SCRATCH, 'staging');

function run() {
  assertScratchIgnored();
  fs.mkdirSync(STAGING, { recursive: true });
  const holdingsOut = fs.createWriteStream(path.join(STAGING, 'holdings.jsonl'));
  const relatedOut = fs.createWriteStream(path.join(STAGING, 'related.jsonl'));
  const stats = {
    decls: 0,
    assets: 0,
    interests: 0,
    unknown: 0,
    egnHits: 0,
    holdings: 0,
    related: 0,
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
  console.log('\n=== extract summary ===');
  console.log(JSON.stringify(stats, null, 2));
}

run();
