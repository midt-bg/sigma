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
import { finished } from 'node:stream/promises';
import { parseList, parseDeclaration } from './parse.mjs';
import { assertScratchIgnored, assertOverrideDirSafe, SCRATCH } from './guard.mjs';
import { corpusStore, CORPUS_STAMP, digest } from './corpus.mjs';
import { safeFolder, safeXmlFile } from './guard.mjs';
import { documentFingerprint, declarationAttribution } from './source-identity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { declaredEiks } from './extract-companies.mjs';

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
async function assertCorpusComplete(store) {
  if (!store.remote && process.argv.includes('--allow-partial-corpus')) {
    console.warn(
      '⚠ --allow-partial-corpus: extracting from a corpus that was never stamped complete. ' +
        'Whatever is missing from the raw cache will be missing from the surface, silently.',
    );
    return;
  }
  const stamp = await store.get(CORPUS_STAMP);
  if (stamp) {
    const parsed = JSON.parse(stamp.toString('utf8'));
    if (
      store.remote &&
      (parsed.schemaVersion !== 2 || !parsed.inventory?.length || parsed.incomplete !== false)
    )
      throw Error('Invalid R2 corpus stamp');
    return parsed;
  }
  throw new Error(
    `REFUSE TO EXTRACT: no completeness stamp at ${RAW}/${CORPUS_STAMP}. The raw corpus was never ` +
      `confirmed whole — it is a deadline stop, a crashed crawl, or a cache restored from one. Extracting ` +
      `now would publish a surface missing whatever the corpus is missing, and nothing downstream would ` +
      `notice: the monotonicity gate sees net growth when new links offset lost ones, and the ship floor ` +
      `only counts. Re-run the crawl to completion (it resumes — declarations on disk are skipped), or ` +
      `pass --allow-partial-corpus to state that a smaller surface is intended.`,
  );
}

export async function run({ store = corpusStore(RAW) } = {}) {
  assertScratchIgnored();
  const stamp = await assertCorpusComplete(store);
  fs.mkdirSync(STAGING, { recursive: true });
  let identify;
  if (process.env.CACBG_REGISTRY_DB) {
    await import('./register-ts.mjs');
    const { registryIdentityResolver } = await import('./registry-identity.mjs');
    const registry = new DatabaseSync(path.resolve(process.env.CACBG_REGISTRY_DB), {
      readOnly: true,
    });
    try {
      identify = registryIdentityResolver(registry);
    } finally {
      registry.close();
    }
  }
  // A failed rerun must not leave an old completion marker beside partial output.
  fs.rmSync(path.join(STAGING, 'manifest.json'), { force: true });
  const holdingsOut = fs.createWriteStream(path.join(STAGING, 'holdings.jsonl'));
  const relatedOut = fs.createWriteStream(path.join(STAGING, 'related.jsonl'));
  // filings.jsonl — one record per DECLARATION (incl. empty / no-material ones that emit no holdings row).
  // The loader builds each person's latest-filing horizon from this to catch a divest-to-ZERO (B1, #226).
  const filingsOut = fs.createWriteStream(path.join(STAGING, 'filings.jsonl'));
  const groupsOut = fs.createWriteStream(path.join(STAGING, 'source-groups.jsonl'));
  const requestsOut = fs.createWriteStream(path.join(STAGING, 'registry-requests.jsonl'));
  const quarantineOut = fs.createWriteStream(path.join(STAGING, 'source-quarantine.jsonl'));
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

  // Deduplicate only identical source bytes; ControlHash is not a unique document ID.
  // Attribution is checked before deduplication, so a bad first listing cannot mask a valid copy.
  const seenHash = new Map();
  const folderRe = /^20\d{2}[A-Za-z0-9_]{0,8}$/;
  const folders = store.remote
    ? stamp.inventory.map((entry) => safeFolder(entry.folder)).sort()
    : fs.existsSync(RAW)
      ? fs
          .readdirSync(RAW)
          .filter((f) => folderRe.test(f))
          .sort()
      : [];
  try {
    for (const folder of folders) {
      let index;
      if (store.remote) {
        const entry = stamp.inventory.find((e) => e.folder === folder);
        const bytes = await store.get(`${folder}/.index.json`);
        if (!bytes || digest(bytes) !== entry.sha256)
          throw Error(`Corpus inventory changed: ${folder}`);
        index = JSON.parse(bytes.toString('utf8'));
      }
      const list = await store.get(`${folder}/list.xml`);
      if (!list) {
        if (store.remote) throw Error(`Missing corpus list: ${folder}`);
        console.log(`  ${folder}: no list.xml, skip`);
        continue;
      }
      if (index && digest(list) !== index.listHash) throw Error(`Corpus list changed: ${folder}`);
      // xmlFile → context (first listing wins; a person with multiple positions shares one filing)
      const ctx = new Map();
      const listedNames = new Map();
      const listXml = list.toString('utf8');
      const listHash = documentFingerprint(listXml);
      const groups = new Map();
      const publications = new Map();
      for (const r of parseList(listXml)) {
        if (!groups.has(r.personLocator))
          groups.set(r.personLocator, { name: r.person, files: new Set() });
        groups.get(r.personLocator).files.add(r.xmlFile);
        if (!ctx.has(r.xmlFile)) ctx.set(r.xmlFile, r);
        const names = listedNames.get(r.xmlFile) ?? [];
        names.push(r.person);
        listedNames.set(r.xmlFile, names);
      }
      let n = 0;
      const files = index
        ? index.files
        : [...(await store.files(folder)).keys()].sort().map((file) => ({ file }));
      if (index) {
        const covered = [...files.map((f) => f.file), ...index.missing];
        if (
          new Set(covered).size !== covered.length ||
          covered.length !== ctx.size ||
          covered.some((f) => !ctx.has(f))
        )
          throw Error(`Corpus inventory does not match list: ${folder}`);
      }
      for (const { file, sha256 } of files) {
        if (safeXmlFile(file) !== file) throw Error('Invalid corpus filename');
        if (file === 'list.xml' || !file.endsWith('.xml')) continue;
        // A single malformed/truncated XML must not abort the whole corpus crawl — skip it and keep going,
        // counting the skip so a rise in skips is visible. (The crawl is a long polite fetch; losing it to
        // one bad file mid-run wastes hours.)
        let d;
        // Storage failures are fatal; only malformed source XML may be quarantined below.
        const bytes = await store.get(`${folder}/${file}`);
        if (!bytes || (store.remote && digest(bytes) !== sha256))
          throw Error(`Corpus file missing or changed: ${folder}/${file}`);
        const xml = bytes.toString('utf8');
        try {
          d = parseDeclaration(xml);
        } catch (err) {
          stats.parseErrors = (stats.parseErrors ?? 0) + 1;
          console.warn(
            `  ! skipped ${folder}/${file}: ${err instanceof Error ? err.message : err}`,
          );
          continue;
        }
        const identity = identify?.(d, listedNames.get(file) ?? []);
        const attribution =
          identity?.attribution ?? declarationAttribution(d.declarant, listedNames.get(file) ?? []);
        if (!['matched', 'registry_alias'].includes(attribution)) {
          stats[attribution] = (stats[attribution] ?? 0) + 1;
          quarantineOut.write(
            JSON.stringify({ folder, xmlFile: file, reason: attribution }) + '\n',
          );
          continue;
        }
        if (attribution === 'registry_alias')
          stats.registryAliases = (stats.registryAliases ?? 0) + 1;
        const fingerprint = documentFingerprint(xml);
        {
          const member = seenHash.get(fingerprint) ?? {
            sourceId: `cacbg:${folder}:${file}`,
            sourceHash: fingerprint,
          };
          publications.set(file, member);
          if (seenHash.has(fingerprint)) {
            stats.dupSkipped++;
            continue;
          } // republished declaration
          seenHash.set(fingerprint, member);
        }
        stats.decls++;
        stats[d.templateType] = (stats[d.templateType] ?? 0) + 1;
        if (d.egnPresent) stats.egnHits++;
        const c = ctx.get(file) ?? {};
        const person = d.declarant;
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
            category: c.category ?? '',
            // The declarant's own „Месторабота" — the institution where the listing only names the declaration
            // type (ADR-0040). Carried on every record so load.mjs keys all three the same way.
            work: d.work ?? '',
            position: c.position || d.position || '',
            declaredPosition: d.position ?? '',
            appointmentNumber: d.appointmentNumber ?? null,
            appointmentDate: d.appointmentDate ?? null,
            companyEvidence: identity?.companies ?? [],
            controlHash: d.controlHash,
            sourceHash: fingerprint,
            identityReason: identity?.reason ?? 'registry_not_read',
            declarationType: d.declarationType,
            assetInventoryComparable: d.assetInventoryComparable ?? false,
            declaredOn: d.declaredOn ?? null,
            submittedOn: d.submittedOn ?? null,
            identityEvidence: identity?.evidence ?? [],
          }) + '\n',
        );
        stats.filings++;
        for (const it of d.interests) {
          for (const eik of declaredEiks(it.entity))
            if (eik.length === 9)
              requestsOut.write(
                JSON.stringify({
                  eik,
                  declarationId: `decl:${folder}:${file}`,
                  declaredName: it.entity,
                }) + '\n',
              );
          holdingsOut.write(
            JSON.stringify({
              folder,
              xmlFile: file,
              year: d.year,
              template: d.templateType,
              category: c.category ?? '',
              institution: c.institution ?? '',
              work: d.work ?? '',
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
              category: c.category ?? '',
              work: d.work ?? '',
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
      for (const [personLocator, group] of groups) {
        if ([...group.files].some((file) => !publications.has(file))) continue;
        const members = [
          ...new Map(
            [...group.files].map((file) => {
              const member = publications.get(file);
              return [member.sourceId, { ...member, xmlFile: file }];
            }),
          ).values(),
        ].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
        if (members.length < 2) continue;
        groupsOut.write(
          JSON.stringify({ folder, listHash, personLocator, name: group.name, members }) + '\n',
        );
        stats.sourceGroups = (stats.sourceGroups ?? 0) + 1;
      }
      console.log(`  ${folder}: ${n} declarations parsed`);
    }
  } finally {
    holdingsOut.end();
    relatedOut.end();
    filingsOut.end();
    quarantineOut.end();
    requestsOut.end();
    groupsOut.end();
    await Promise.all(
      [holdingsOut, relatedOut, filingsOut, quarantineOut, requestsOut, groupsOut].map((stream) =>
        finished(stream),
      ),
    );
  }
  fs.writeFileSync(
    path.join(STAGING, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 8,
        filingsHash: documentFingerprint(fs.readFileSync(path.join(STAGING, 'filings.jsonl'))),
        sourceGroupsHash: documentFingerprint(
          fs.readFileSync(path.join(STAGING, 'source-groups.jsonl')),
        ),
        corpusComplete: !process.argv.includes('--allow-partial-corpus'),
        identityRules: identify ? 'registry-identity-3' : null,
        extractedAt: new Date().toISOString(),
        raw: store.remote ? 'r2:declarations/corpus-v2' : RAW,
        filings: stats.filings,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('\n=== extract summary ===');
  console.log(JSON.stringify(stats, null, 2));
}

// Only run when invoked directly — importing the module (e.g. a future unit test of a pure helper) must
// not trigger a real extraction pass over the raw cache. Matches the guard in fetch.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
