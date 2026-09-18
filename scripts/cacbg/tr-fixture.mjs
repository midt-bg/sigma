// TEST HELPER — not part of the pipeline, and deliberately not named *.test.mjs so the runner does
// not execute it as a suite.
//
// The decision is reached by the decision pass (scripts/tr/decide.mjs), against the registry facts of
// each company, and `load.mjs` only reads what was decided. A fixture that seeds no verdicts therefore
// exercises nothing: the loader would find no verdict and hold every link. This helper closes that gap the
// honest way — it runs the real `decideLinks` over fixture registry facts, so a load test still exercises
// the real evidence ladder rather than hand-written verdict rows that could drift away from what
// `evidenceVerdict` actually returns.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openCache, upsertDeed, markOutsideTr, readDeed } from '../tr/cache.mjs';
import { readLinksFile, decideLinks } from '../tr/decide.mjs';
import { registryFacts } from '../tr/deed.mjs';
import { IDENTITY_RULES_VERSION } from './registry-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// Tests that edit a fixture's declarations model a fresh extraction, with its new content hash.
export function sealFixtureFilings(staging) {
  const file = path.join(staging, 'filings.jsonl');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const manifest = path.join(staging, 'manifest.json');
  if (!fs.existsSync(manifest)) return;
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  value.filingsHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(manifest, JSON.stringify(value));
}

/** Run `load.mjs --emit-candidates` against a fixture work DB and return the emitted link records. */
export function emitLinkRecords({ workDb, staging, trDb }) {
  const db = new DatabaseSync(workDb);
  db.exec(fs.readFileSync(path.join(ROOT, 'packages/db/migrations/0013_registry.sql'), 'utf8'));
  if (
    !db
      .prepare('PRAGMA table_info(registry_roles)')
      .all()
      .some((c) => c.name === 'uncertain_after')
  )
    db.exec(
      fs.readFileSync(
        path.join(ROOT, 'packages/db/migrations/0017_registry_identity_observations.sql'),
        'utf8',
      ),
    );
  db.close();
  const f = path.join(staging, 'filings.jsonl');
  if (fs.existsSync(f))
    fs.writeFileSync(
      f,
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const rec = JSON.parse(line);
          return JSON.stringify({
            sourceHash: createHash('sha256').update(line).digest('hex'),
            ...rec,
          });
        })
        .join('\n') + '\n',
    );
  const manifest = path.join(staging, 'manifest.json');
  if (!fs.existsSync(manifest))
    fs.writeFileSync(
      manifest,
      JSON.stringify({ schemaVersion: 8, identityRules: IDENTITY_RULES_VERSION }),
    );
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const groupsFile = path.join(staging, 'source-groups.jsonl');
  if (!fs.existsSync(groupsFile)) fs.writeFileSync(groupsFile, '');
  if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  if (m.schemaVersion === 8)
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        ...m,
        identityRules: IDENTITY_RULES_VERSION,
        filingsHash: createHash('sha256')
          .update(fs.readFileSync(path.join(staging, 'filings.jsonl')))
          .digest('hex'),
        sourceGroupsHash: createHash('sha256').update(fs.readFileSync(groupsFile)).digest('hex'),
      }),
    );
  execFileSync(
    'node',
    [
      '--import',
      path.join(HERE, 'register-ts.mjs'),
      path.join(HERE, 'load.mjs'),
      '--emit-candidates',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CACBG_DB: workDb, CACBG_STAGING: staging, TR_CACHE_DB: trDb },
      stdio: 'pipe',
    },
  );
  return readLinksFile(path.join(staging, 'candidate-links.jsonl'));
}

/** The register's legal-form codes for the numeric ones older fixtures were written with. */
const FORM = { 1: 'ET', 4: 'OOD', 5: 'AD', 6: 'KDA', 10: 'EOOD' };

/**
 * Registry facts for a fixture company, as the decision pass reads them from the registry layer:
 * `owners` and `managers` are persons standing in those roles, each its own registered holder; `form`
 * is the legal form — the register's code, or a numeric one older fixtures use — and `suffix` the
 * ЗТРРЮЛНЦ form on the name.
 */
export function fixtureRegistry(
  eik,
  {
    owners = [],
    pastOwners = [],
    managers = [],
    seat = null,
    seatEntryDate = null,
    ownEntryDate = '2011-05-02',
    form = 'OOD',
    suffix = null,
  } = {},
) {
  const code = typeof form === 'number' ? (FORM[form] ?? `CODE${form}`) : form;
  const holder = (field, name, removedOn = null) => ({
    field_ident: field,
    subject_kind: 'person',
    subject_name: name,
    entry_number: '20110502101007',
    added_on: ownEntryDate,
    removed_on: removedOn,
  });
  return registryFacts(
    {
      eik,
      name: suffix ? `"ФИКС" ${suffix}` : 'ФИКС',
      legal_form: code,
      seat_settlement: seat,
      seat_entry_on: seat ? (seatEntryDate ?? ownEntryDate) : null,
      owners_entry_on: owners.length ? ownEntryDate : null,
    },
    [
      ...owners.map((n) => holder('00190', n)),
      ...pastOwners.map((n) => holder('00190', n, '2020-06-30')),
      ...managers.map((n) => holder('00070', n)),
    ],
  );
}

/**
 * Decide every fixture link against its fixture registry facts, exactly as the decision pass would.
 *
 * `registryFor(eik)` returns `{ registry }` for a company the registry layer has read, `{ outsideTr: true }`
 * for one the register has no partida for, or `null` for one the layer never read — which must leave NO
 * verdict, because that is what an incomplete registry looks like and several tests turn on it.
 */
export function seedVerdicts({
  workDb,
  staging,
  trDb,
  registryFor,
  now = new Date('2026-08-05T00:00:00Z'),
}) {
  const links = emitLinkRecords({ workDb, staging, trDb });
  const db = openCache(trDb);
  try {
    for (const eik of [...new Set(links.map((l) => l.eik))]) {
      const entry = registryFor(eik);
      if (entry == null) continue; // never read — no deed row, no verdict
      if (entry.outsideTr) {
        markOutsideTr(db, eik, 'the register has no partida for this ЕИК', now, {
          unambiguous: true,
        });
        decideLinks(db, { eik, registry: null, outsideTr: true, links, now });
        continue;
      }
      // Only when the fixture has not already written the row. Re-upserting here would overwrite the
      // columns the caller populated by hand with NULLs — harmless while nothing reads them, and a trap
      // the moment something does.
      if (!readDeed(db, eik)) {
        upsertDeed(db, { eik, status: 'fetched', httpStatus: 200, fetchedAt: now.toISOString() });
      }
      decideLinks(db, { eik, registry: entry.registry, outsideTr: false, links, now });
    }
  } finally {
    db.close();
  }
  return links;
}
