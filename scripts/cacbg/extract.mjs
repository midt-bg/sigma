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
import { corpusStore, corpusFiles, CORPUS_STAMP, CORPUS_VERSION, digest } from './corpus.mjs';
import { progress } from './progress.mjs';
import { safeFolder, safeXmlFile } from './guard.mjs';
import { documentFingerprint, declarationAttribution } from './source-identity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { declaredEiks } from './extract-companies.mjs';
import {
  checkpointFingerprint,
  commitFolder,
  concatParts,
  partPath,
  readHead,
  restoreParts,
  seenHashFrom,
  STREAMS,
} from './extract-checkpoint.mjs';

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
      (parsed.schemaVersion !== CORPUS_VERSION ||
        !parsed.inventory?.length ||
        parsed.incomplete !== false)
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

// The platform asks a container to stop with SIGTERM and then waits. The answer is to accept the
// current folder and exit 75 — the code the coordinator reads as an intentional yield and retries at
// once. Without a handler Node would die mid-folder and the work of that folder would be lost.
let yielding = false;
export function requestYield() {
  yielding = true;
}

export async function run({ store = corpusStore(RAW), yieldAfterFolders = Infinity } = {}) {
  assertScratchIgnored();
  const stamp = await assertCorpusComplete(store);
  progress('extract');
  let processed = 0;
  fs.mkdirSync(STAGING, { recursive: true });
  let identify;
  let identityRules = null;
  let registryDigest = 'no-registry';
  if (process.env.CACBG_REGISTRY_DB) {
    await import('./register-ts.mjs');
    const { registryIdentityResolver, IDENTITY_RULES_VERSION, identityInputsDigest } =
      await import('./registry-identity.mjs');
    identityRules = IDENTITY_RULES_VERSION;
    const registry = new DatabaseSync(path.resolve(process.env.CACBG_REGISTRY_DB), {
      readOnly: true,
    });
    try {
      identify = registryIdentityResolver(registry);
      registryDigest = identityInputsDigest(registry);
    } finally {
      registry.close();
    }
  }
  // A failed rerun must not leave an old completion marker beside partial output.
  fs.rmSync(path.join(STAGING, 'manifest.json'), { force: true });
  // Every folder writes its own six parts; the final files are the parts concatenated in folder order.
  // That way an interrupted pass leaves whole folders behind, not half a file (see extract-checkpoint).
  // filings — one record per DECLARATION (incl. empty / no-material ones that emit no holdings row).
  // The loader builds each person's latest-filing horizon from it to catch a divest-to-ZERO (B1, #226).
  const partsDir = path.join(STAGING, 'parts');
  let holdingsOut, relatedOut, filingsOut, groupsOut, requestsOut, quarantineOut;
  let parts = [];
  const openParts = (folder) => {
    parts = STREAMS.map((stream) => fs.createWriteStream(partPath(partsDir, folder, stream)));
    [holdingsOut, relatedOut, filingsOut, groupsOut, requestsOut, quarantineOut] = parts;
  };
  const closeParts = async () => {
    for (const stream of parts) stream.end();
    await Promise.all(parts.map((stream) => finished(stream)));
    parts = [];
  };
  let stats = {
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
  let seenHash = new Map();
  const folderRe = /^20\d{2}[A-Za-z0-9_]{0,8}$/;
  const folders = store.remote
    ? stamp.inventory.map((entry) => safeFolder(entry.folder)).sort()
    : fs.existsSync(RAW)
      ? fs
          .readdirSync(RAW)
          .filter((f) => folderRe.test(f))
          .sort()
      : [];
  // The checkpoint lives with the corpus and is bound to this logical run and to its inputs: the
  // stamped corpus, the identity rules, the output schema, and the registry facts the resolver read.
  const runId = process.env.SIGMA_RUN_ID;
  const checkpointing = Boolean(store.remote && runId);
  const fingerprint = checkpointFingerprint([
    digest(Buffer.from(JSON.stringify(stamp?.inventory ?? []))),
    identityRules ?? 'no-identity',
    'schema-8',
    registryDigest,
  ]);
  let head = { fingerprint, folders: [] };
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });
  if (checkpointing) {
    const accepted = await readHead(store, runId, fingerprint);
    if (accepted?.folders.length) {
      // Restoring is progress too: without these reports the coordinator sees a silent container.
      await restoreParts(store, {
        runId,
        fingerprint,
        dir: partsDir,
        head: accepted,
        onFolder: (folder) => progress('extract', accepted.processed ?? 0, undefined, true),
      });
      head = accepted;
      seenHash = seenHashFrom(partsDir, accepted.folders);
      stats = accepted.stats ?? stats;
      processed = accepted.processed ?? 0;
      console.log(
        `resumed after ${accepted.folders.length} folder(s): ${processed} declarations already read`,
      );
    }
  }
  const done = new Set(head.folders);
  const order = [...head.folders];
  let folderCount = 0;
  try {
    for (const folder of folders) {
      if (done.has(folder)) continue;
      let index;
      const indexBytes = await store.get(`${folder}/.index.json`);
      if (store.remote) {
        const entry = stamp.inventory.find((e) => e.folder === folder);
        if (!indexBytes || digest(indexBytes) !== entry.sha256)
          throw Error(`Corpus inventory changed: ${folder}`);
      }
      if (indexBytes) index = JSON.parse(indexBytes.toString('utf8'));
      const list = await store.get(`${folder}/list.xml`);
      if (!list) {
        if (store.remote) throw Error(`Missing corpus list: ${folder}`);
        console.log(`  ${folder}: no list.xml, skip`);
        continue;
      }
      if (index && digest(list) !== index.listHash) throw Error(`Corpus list changed: ${folder}`);
      openParts(folder);
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
      for await (const { file, sha256, bytes, sourceFolder } of corpusFiles(
        store,
        folder,
        files.filter(({ file }) => file !== 'list.xml' && file.endsWith('.xml')),
      )) {
        if (safeXmlFile(file) !== file) throw Error('Invalid corpus filename');
        if (file === 'list.xml' || !file.endsWith('.xml')) continue;
        // A single malformed/truncated XML must not abort the whole corpus crawl — skip it and keep going,
        // counting the skip so a rise in skips is visible. (The crawl is a long polite fetch; losing it to
        // one bad file mid-run wastes hours.)
        let d;
        // Storage failures are fatal; only malformed source XML may be quarantined below.
        if (!bytes || (store.remote && digest(bytes) !== sha256))
          throw Error(`Corpus file missing or changed: ${folder}/${file}`);
        progress('extract', ++processed);
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
        // `name_variant` is an accepted attribution (the register's own spelling slip), counted below
        // so its rate stays visible; everything else is quarantined for review.
        if (!['matched', 'registry_alias', 'name_variant'].includes(attribution)) {
          stats[attribution] = (stats[attribution] ?? 0) + 1;
          quarantineOut.write(
            JSON.stringify({ folder, xmlFile: file, reason: attribution }) + '\n',
          );
          continue;
        }
        if (attribution === 'registry_alias')
          stats.registryAliases = (stats.registryAliases ?? 0) + 1;
        if (attribution === 'name_variant') stats.nameVariants = (stats.nameVariants ?? 0) + 1;
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
            sourceFolder,
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
              sourceFolder,
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
        // A family stake's holder: internal only, so the register can confirm the relative (ADR-0044).
        const stakeHolders = d.interests
          .filter((it) => it.holderRelation === 'related' && it.holder)
          .map((it) => ({
            name: it.holder,
            kind: 'stake_holder',
            info: it.entity,
            timing: it.timing,
          }));
        for (const rp of [...d.relatedPersons, ...stakeHolders]) {
          relatedOut.write(
            JSON.stringify({
              folder,
              sourceFolder,
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
      // The folder boundary is the only clean cut: its groups are written, and its input was pinned by
      // the stamped index. Accept it, then stop if the platform asked us to.
      await closeParts();
      order.push(folder);
      if (checkpointing)
        head = await commitFolder(store, {
          runId,
          fingerprint,
          dir: partsDir,
          head,
          folder,
          stats,
          processed,
        });
      if (++folderCount >= yieldAfterFolders || yielding) {
        console.log(`yielding after ${folder}: ${processed} declarations read`);
        return 75;
      }
    }
  } finally {
    await closeParts();
  }
  concatParts(partsDir, order, (stream) => path.join(STAGING, `${stream}.jsonl`));
  fs.rmSync(partsDir, { recursive: true, force: true });
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
        identityRules,
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
  return 0;
}

// Only run when invoked directly — importing the module (e.g. a future unit test of a pure helper) must
// not trigger a real extraction pass over the raw cache. Matches the guard in fetch.mjs: run() returns
// the exit code and it is assigned to process.exitCode, so stdout drains naturally.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, requestYield);
  const after = process.argv.indexOf('--yield-after-folders');
  const code = await run({
    yieldAfterFolders: after > 0 ? Number(process.argv[after + 1]) : Infinity,
  });
  process.exitCode = code;
}
