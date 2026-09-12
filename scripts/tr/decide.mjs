// The decision pass (issue #279, ADR-0033, ADR-0037, ADR-0041): every candidate link decided against the
// registry facts of its company. No network. No deed.
//
// The facts come from the registry layer the daily ETL keeps in D1 — exported, read-only, into the work DB
// this job already builds (`--registry-db`). What survives is exactly what survived before: a verdict per
// (link, ЕИК) — a kind, a role, an entry reference and booleans, and no name of anyone without public office
// (ADR-0037). The cache that holds the verdicts is rebuilt from nothing on every run: every fact is at hand,
// so every link is decided again against today's registry, and nothing decided against an older one can
// linger.
//
// A company the registry layer has not read yet gets NO verdict — not a false one. An absent verdict is what
// the loader's floor counts (load.mjs), while a fabricated „unknown" would hide the gap it measures.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { assertTrScratchIgnored, TR_DB, safeEik } from './paths.mjs';
import { openCache, upsertDeed, markOutsideTr, splitLinkRecord, upsertVerdict } from './cache.mjs';
import { evidenceVerdict, reconcileTermination, RULES_VERSION } from './evidence.mjs';
import {
  registryFacts,
  registryLegalForm,
  registrySeat,
  latestOwnershipEntryDate,
  ROLE_FIELDS,
} from './deed.mjs';

/**
 * Read the closed LINK set: one JSON object per line, each the `evidenceVerdict` input for one link
 * plus the `linkKey` and `eik` it belongs to (ADR-0037).
 *
 * It carries declarant names — public officials, already published by the source register and by our
 * own surface — and never a relative or a co-owner.
 */
export function readLinksFile(file) {
  const links = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      throw new Error(`${file}:${i + 1}: not JSON — ${e.message}`);
    }
    if (!rec.linkKey || !rec.eik) throw new Error(`${file}:${i + 1}: needs both linkKey and eik`);
    // Split and hashed through the SAME helper the loader uses — never a subset assembled locally,
    // which is how the two sides would drift and every verdict lookup would miss.
    const link = splitLinkRecord(rec);
    links.push({ ...link, eik: safeEik(link.eik) });
  }
  return links;
}

/**
 * Decide every link on one ЕИК against its registry facts and record the verdicts.
 *
 * `now` is the day the evidence was gathered — the registry layer's read of the partida — and it is what
 * the verdict records as decided: the loader seals it on the link as the date of the lookup, and a
 * decision taken today on a partida read yesterday must not make the evidence look fresher than it is.
 *
 * A link whose evidence cannot be read is left WITHOUT a verdict rather than given a false one.
 */
export function decideLinks(db, { eik, registry, outsideTr, links, now }) {
  let decided = 0;
  let refused = 0;
  // Counted, not merely stored. `shortName`/`latinInName` are the ladder's own record of names it
  // could not assert on; columns written and never read are a claim nobody checks.
  let shortName = 0;
  let latinInName = 0;
  for (const link of links) {
    if (link.eik !== eik) continue;
    try {
      const verdict = evidenceVerdict({ ...link.input, registry, outsideTr });
      // The SECOND question the register answers: §7's divestment reconciliation checks whether the
      // declarant is still a registered owner. Computed unconditionally because whether it is consulted
      // depends on declaration state this pass does not have; it is pure, cheap, and short-circuits for
      // family scope without reading anything.
      const recon = reconcileTermination({
        registry,
        declarantName: link.input.declarantName,
        scope: link.input.scope,
      });
      upsertVerdict(db, {
        linkKey: link.linkKey,
        eik,
        rulesVersion: verdict.rulesVersion ?? RULES_VERSION,
        inputsHash: link.inputsHash,
        kind: verdict.kind,
        publishable: verdict.publishable,
        registryRole: verdict.registryRole,
        matchedFact: verdict.matchedFact,
        entryNumber: verdict.entryNumber,
        entryDate: verdict.entryDate,
        roleEndedOn: verdict.roleEndedOn,
        shortName: verdict.shortName,
        latinInName: verdict.latinInName,
        reconTerminated: recon.terminated,
        reconLabel: recon.label,
        decidedAt: now.toISOString(),
      });
      if (verdict.shortName) shortName++;
      if (verdict.latinInName) latinInName++;
      decided++;
    } catch (err) {
      console.error(
        `  ${eik}: link ${link.linkKey} UNDECIDED — ${err instanceof Error ? err.message : err}`,
      );
      refused++;
    }
  }
  return { decided, refused, shortName, latinInName };
}

/**
 * One company's registry facts from the exported registry tables: `{ registry, fetchedAt }`, or
 * `{ outsideTr: true, fetchedAt }` for an ЕИК the register has no partida for, or null when the registry
 * layer has not read it yet.
 */
export function readRegistry(src, eik) {
  const deed = src
    .prepare(
      `SELECT eik, name, legal_form, seat_settlement, seat_entry_on, owners_entry_on, outcome, fetched_at
         FROM registry_deeds WHERE eik = ?`,
    )
    .get(safeEik(eik));
  if (!deed) return null;
  if (deed.outcome === 'absent') return { outsideTr: true, fetchedAt: deed.fetched_at };
  const roles = src
    .prepare(
      `SELECT field_ident, subject_kind, subject_name, entry_number, added_on, removed_on
         FROM registry_roles WHERE eik = ? AND field_ident IN (${ROLE_FIELDS.map(() => '?').join(', ')})`,
    )
    .all(deed.eik, ...ROLE_FIELDS);
  return { registry: registryFacts(deed, roles), fetchedAt: deed.fetched_at };
}

const argOf = (argv, name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};

/**
 * Decide every candidate link. Returns the intended process exit code, so the policy is testable without
 * a global side effect: 0 when every link that has facts was decided, 1 when any link could not be.
 */
export function run({
  argv = process.argv,
  guard = assertTrScratchIgnored,
  dbFile = TR_DB,
  log = console.log,
} = {}) {
  guard();
  const linksFile = argOf(argv, 'links-file');
  const registryDb = argOf(argv, 'registry-db');
  if (!linksFile || !registryDb)
    throw new Error('both --links-file and --registry-db are required');

  const links = readLinksFile(linksFile);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true });
  const db = openCache(dbFile);
  const src = new DatabaseSync(registryDb, { readOnly: true });
  const tally = { decided: 0, refused: 0, outsideTr: 0, shortName: 0, latinInName: 0 };
  const unread = [];
  const eiks = [...new Set(links.map((l) => l.eik))].sort();
  try {
    for (const eik of eiks) {
      const found = readRegistry(src, eik);
      if (!found) {
        unread.push(eik);
        continue;
      }
      const at = new Date(found.fetchedAt);
      if (found.outsideTr) {
        // The register's own answer that it has no partida — not an empty body that needs a second look.
        markOutsideTr(db, eik, 'the register has no partida for this ЕИК', at, {
          unambiguous: true,
        });
        tally.outsideTr++;
      } else {
        const form = registryLegalForm(found.registry);
        const seat = registrySeat(found.registry);
        upsertDeed(db, {
          eik,
          status: 'fetched',
          fetchedAt: at.toISOString(),
          legalFormVerdict: form.verdict,
          seatNormalized: seat.settlement || null,
          seatEntryDate: seat.entryDate,
          latestOwnEntryDate: latestOwnershipEntryDate(found.registry),
        });
      }
      const r = decideLinks(db, {
        eik,
        registry: found.registry ?? null,
        outsideTr: Boolean(found.outsideTr),
        links,
        now: at,
      });
      tally.decided += r.decided;
      tally.refused += r.refused;
      tally.shortName += r.shortName;
      tally.latinInName += r.latinInName;
    }
  } finally {
    src.close();
    db.close();
  }
  log(
    `links ${links.length} · companies ${eiks.length} · decided ${tally.decided} · outside ТР ${tally.outsideTr}` +
      ` · not yet read by the registry layer ${unread.length} · undecided ${tally.refused}` +
      ` · short names ${tally.shortName} · Latin in name ${tally.latinInName}`,
  );
  // ЕИК only, never link_key: the key embeds the official's name, and a name has no business in a CI
  // log (ADR-0033 decision 5).
  if (unread.length)
    log(
      `  not yet read: ${unread.slice(0, 20).join(', ')}` +
        (unread.length > 20 ? ` … and ${unread.length - 20} more` : ''),
    );
  return tally.refused > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
