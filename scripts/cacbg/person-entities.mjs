import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { declarantNameKey } from './source-identity.mjs';
import {
  registryIdentityRows,
  registryCompanyResolver,
  IDENTITY_RULES_VERSION,
} from './registry-identity.mjs';
import { declarationContinuity, COMPANY_AUTHOR_BASIS } from './declaration-continuity.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const declarationSourceId = (rec) => `cacbg:${rec.folder}:${rec.xmlFile}`;
const registrySourceId = (indent) => `tr:${indent}`;

/** Connected accepted evidence only. A conflicting component is quarantined as a whole;
 * processing order must never decide which of two different people inherits its documents. */
export function identityComponents(sources, evidence) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const parent = new Map(sources.map((s) => [s.id, s.id]));
  const root = (id) => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, r);
      id = next;
    }
    return r;
  };
  const current = evidence.filter(
    (e) =>
      e.origin === 'automatic' &&
      e.decision === 'accepted' &&
      byId.get(e.left_source)?.source_hash === e.left_hash &&
      byId.get(e.right_source)?.source_hash === e.right_hash,
  );
  for (const e of current)
    if (e.relation === 'same') parent.set(root(e.right_source), root(e.left_source));
  const groups = new Map();
  for (const s of sources) {
    const key = root(s.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const conflicts = new Set(
    current
      .filter((e) => e.relation === 'different' && root(e.left_source) === root(e.right_source))
      .map((e) => root(e.left_source)),
  );
  const result = [];
  for (const [key, members] of groups) {
    const ids = new Set(members.filter((s) => s.namespace === 'tr').map((s) => s.source_key));
    if (ids.size > 1 || conflicts.has(key)) {
      result.push(...members.map((s) => ({ members: [s], conflict: true })));
    } else result.push({ members, conflict: false });
  }
  return result;
}

/** Revalidate exact per-entry proofs before any aggregate adopts a canonical person.
 * Continuity can attach documents to an anchor, never infer ownership from a family member. */
export function rebuildPersonEntities(
  db,
  registry,
  filings,
  legacyId,
  priorDocuments = new Map(),
  now = new Date().toISOString(),
  sourceGroups = [],
) {
  db.exec(
    fs.readFileSync(
      new URL('../../packages/db/migrations/0018_person_entities.sql', import.meta.url),
      'utf8',
    ),
  );
  const observations = registryIdentityRows(registry);
  const companyNames = new Map();
  const observationByLocator = new Map();
  for (const r of observations) {
    const key = `${r.eik}|${declarantNameKey(r.subject_name)}`;
    if (!companyNames.has(key)) companyNames.set(key, new Set());
    companyNames.get(key).add(r.subject_id);
    observationByLocator.set(
      JSON.stringify([r.eik, r.sub_uic, r.field_ident, r.entry_number, r.holder_index]),
      r,
    );
  }
  const previous = new Map(
    db
      .prepare('SELECT id,entity_id FROM person_sources')
      .all()
      .map((s) => [s.id, s.entity_id]),
  );
  const assignments = new Map();
  const bySource = new Map(filings.map((f) => [declarationSourceId(f), f]));
  const stats = {
    sourceGroups: 0,
    rejectedSourceGroups: 0,
    documents: filings.length,
    resolved: 0,
    unresolved: 0,
    conflicts: 0,
    revoked: 0,
    continuityAccepted: 0,
    continuityCandidates: 0,
  };
  db.exec('BEGIN');
  try {
    db.exec("UPDATE person_sources SET active=0 WHERE namespace IN ('cacbg','tr')");
    const putSource =
      db.prepare(`INSERT INTO person_sources(id,namespace,source_key,source_hash,name,legacy_person_id,active)
      VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,name=excluded.name,
      legacy_person_id=excluded.legacy_person_id,active=1`);
    const alias = db.prepare('INSERT OR IGNORE INTO person_source_aliases VALUES(?,?)');
    const reason = db.prepare('UPDATE person_sources SET resolution_reason=? WHERE id=?');
    const putEvidence =
      db.prepare(`INSERT INTO person_identity_evidence VALUES(?,?,?,?,?,?,?,'automatic',?,?,?)
      ON CONFLICT(id) DO UPDATE SET origin='automatic',decision=excluded.decision,observed_at=excluded.observed_at`);
    db.exec("UPDATE person_identity_evidence SET decision='revoked' WHERE decision<>'revoked'");
    for (const r of observations)
      putSource.run(
        registrySourceId(r.subject_id),
        'tr',
        r.subject_id,
        r.subject_id,
        r.subject_name,
        null,
      );
    for (const f of filings) {
      const id = declarationSourceId(f);
      if (!f.sourceHash || !/^[a-f0-9]{64}$/.test(f.sourceHash))
        throw new Error(`Missing document version: ${id}`);
      putSource.run(id, 'cacbg', `${f.folder}:${f.xmlFile}`, f.sourceHash, f.person, legacyId(f));
      for (const old of [
        legacyId(f),
        priorDocuments.get(`${f.folder}:${f.xmlFile}`),
        previous.get(id),
      ])
        if (old) alias.run(old, id);
      reason.run(f.identityReason ?? 'no_identity_evidence', id);
      const proofs = f.identityEvidence ?? [];
      const ambiguous = new Set(proofs.map((p) => p.registryIndent)).size > 1;
      if (ambiguous) {
        stats.conflicts++;
        reason.run('ambiguous_registry_identity', id);
      }
      for (const p of proofs) {
        const o = p.observation;
        const row =
          o &&
          observationByLocator.get(
            JSON.stringify([p.eik, o.subUic, o.fieldIdent, p.entryNumber, o.holderIndex]),
          );
        if (
          p.rule !== IDENTITY_RULES_VERSION ||
          p.documentName !== f.person ||
          !row ||
          row.source_hash !== o.sourceHash ||
          row.subject_id !== p.registryIndent ||
          declarantNameKey(row.subject_name) !== declarantNameKey(f.person)
        )
          throw new Error(`Identity proof no longer matches its source: ${id}`);
        // The listing and XML must be the same person, including independently evidenced name changes.
        if (
          !Array.isArray(p.listedNames) ||
          !p.listedNames.length ||
          p.listedNames.some((name) => {
            if (declarantNameKey(name) === declarantNameKey(f.person)) return false;
            return (
              new Set(proofs.map((p) => p.registryIndent)).size !== 1 ||
              !proofs.some((candidate) =>
                [f.person, ...p.listedNames].every((alias) => {
                  const ids = companyNames.get(`${candidate.eik}|${declarantNameKey(alias)}`);
                  return ids?.size === 1 && ids.has(p.registryIndent);
                }),
              )
            );
          })
        )
          throw new Error(`Unproven listing alias: ${id}`);
        const right = registrySourceId(p.registryIndent);
        // The registry namespace identifies the individual. Its exact observation version lives on the edge.
        const facts = JSON.stringify(p);
        putEvidence.run(
          hash(`${id}|${f.sourceHash}|${facts}`),
          id,
          right,
          f.sourceHash,
          p.registryIndent,
          'same',
          ambiguous ? 'candidate' : 'accepted',
          p.rule,
          facts,
          now,
        );
      }
    }
    // Groups come from one exact Person node in one version of the official listing.
    // Repeat publications refer to the retained byte-identical document, not its filename.
    for (const group of sourceGroups) {
      if (
        !/^20\d{2}[A-Za-z0-9_]{0,8}$/.test(group.folder) ||
        !/^[a-f0-9]{64}$/.test(group.listHash) ||
        !Number.isSafeInteger(group.personLocator) ||
        group.personLocator < 1 ||
        typeof group.name !== 'string' ||
        !group.name.trim() ||
        !Array.isArray(group.members) ||
        group.members.length < 2 ||
        new Set(group.members.map((m) => m.sourceId)).size !== group.members.length
      )
        throw new Error('Invalid declaration source group');
      const members = group.members.map((m) => {
        const f = bySource.get(m.sourceId);
        if (!f || f.sourceHash !== m.sourceHash)
          throw new Error(`Source group no longer matches its document: ${m.sourceId}`);
        return f;
      });
      if (
        members.some((f) => {
          const proofs = f.identityEvidence ?? [];
          const ids = new Set(proofs.map((p) => p.registryIndent));
          const names = [f.person, ...proofs.flatMap((p) => p.listedNames)];
          return (
            ids.size > 1 ||
            !names.some((name) => declarantNameKey(name) === declarantNameKey(group.name))
          );
        })
      ) {
        stats.rejectedSourceGroups++;
        continue;
      }
      const [left, ...rest] = [...group.members].sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId),
      );
      for (const right of rest) {
        const facts = JSON.stringify({
          folder: group.folder,
          listHash: group.listHash,
          personLocator: group.personLocator,
          name: group.name,
          members: [left, right],
        });
        putEvidence.run(
          hash(`source-groups-1|${facts}`),
          left.sourceId,
          right.sourceId,
          left.sourceHash,
          right.sourceHash,
          'same',
          'accepted',
          'source-groups-1',
          facts,
          now,
        );
      }
      stats.sourceGroups++;
    }
    // Only automatic evidence participates. Source versions are checked again before assignment.
    db.exec(`UPDATE person_identity_evidence SET decision='revoked' WHERE decision<>'revoked' AND (
      NOT EXISTS(SELECT 1 FROM person_sources s WHERE s.id=left_source AND s.active=1 AND s.source_hash=left_hash)
      OR NOT EXISTS(SELECT 1 FROM person_sources s WHERE s.id=right_source AND s.active=1 AND s.source_hash=right_hash))`);
    const sources = db.prepare('SELECT * FROM person_sources WHERE active=1 ORDER BY id').all();
    const evidence = db
      .prepare(
        "SELECT * FROM person_identity_evidence WHERE decision='accepted' AND origin='automatic'",
      )
      .all();
    const proposed = declarationContinuity(filings, registryCompanyResolver(registry));
    // Test the complete proposed graph, including every ambiguous registry candidate.
    // Reject all new edges in a conflicting component, preserving already proven anchors.
    const ambiguous = db
      .prepare(
        "SELECT * FROM person_identity_evidence WHERE decision='candidate' AND rule_version=?",
      )
      .all(IDENTITY_RULES_VERSION)
      .map((e) => ({ ...e, decision: 'accepted' }));
    const companySources = new Set(
      proposed
        .filter((e) => JSON.parse(e.facts).basis === COMPANY_AUTHOR_BASIS)
        .flatMap((e) => [e.left_source, e.right_source]),
    );
    const blocked = new Set(),
      supported = new Set(),
      companyAuthors = new Set();
    for (const c of identityComponents(sources, [...evidence, ...ambiguous, ...proposed])) {
      if (c.conflict) for (const s of c.members) blocked.add(s.id);
      else if (c.members.some((s) => s.namespace === 'tr' || companySources.has(s.id)))
        for (const s of c.members) supported.add(s.id);
    }
    for (const e of proposed) {
      const conflict = blocked.has(e.left_source) || blocked.has(e.right_source);
      if (!conflict && !supported.has(e.left_source)) continue;
      e.decision = conflict ? 'candidate' : 'accepted';
      putEvidence.run(
        e.id,
        e.left_source,
        e.right_source,
        e.left_hash,
        e.right_hash,
        e.relation,
        e.decision,
        e.rule_version,
        e.facts,
        now,
      );
      stats[conflict ? 'continuityCandidates' : 'continuityAccepted']++;
      if (!conflict) {
        evidence.push(e);
        if (JSON.parse(e.facts).basis === COMPANY_AUTHOR_BASIS) {
          companyAuthors.add(e.left_source);
          companyAuthors.add(e.right_source);
        }
      }
    }
    const components = identityComponents(sources, evidence);
    // Registry-anchored components retain their entity first when an old component splits.
    components.sort(
      (a, b) =>
        Number(b.members.some((s) => s.namespace === 'tr')) -
          Number(a.members.some((s) => s.namespace === 'tr')) ||
        a.members[0].id.localeCompare(b.members[0].id),
    );
    const used = new Set();
    const insertEntity = db.prepare(
      'INSERT INTO person_entities VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET registry_indent=excluded.registry_indent',
    );
    const assign = db.prepare('UPDATE person_sources SET entity_id=? WHERE id=?');
    db.exec('UPDATE person_sources SET entity_id=NULL');
    for (const c of components) {
      const anchor = c.members.find((s) => s.namespace === 'tr');
      // Repeated full name + verified company establishes an author without inventing a TR identity.
      // A listing or employment chain alone still stays in its source archive.
      const resolved =
        !c.conflict && (Boolean(anchor) || c.members.some((s) => companyAuthors.has(s.id)));
      let entity = null;
      if (resolved) {
        entity = [
          anchor && previous.get(anchor.id),
          ...c.members.map((s) => previous.get(s.id)),
        ].find((id) => id && !used.has(id));
        if (!entity) entity = `person:identity:${hash((anchor ?? c.members[0]).id)}`;
        // A revoked/split entity is never reused for two different components.
        if (used.has(entity))
          entity = `person:identity:${hash(
            c.members
              .map((s) => s.id)
              .sort()
              .join('|'),
          )}`;
        used.add(entity);
        insertEntity.run(entity, anchor?.source_key ?? null, now);
      }
      for (const s of c.members) {
        assign.run(entity, s.id);
        if (entity || c.conflict)
          reason.run(c.conflict ? 'conflicting_identity' : 'verified_identity', s.id);
        if (entity) alias.run(entity, s.id);
        if (s.namespace === 'cacbg') {
          assignments.set(s.id, entity ?? s.legacy_person_id);
          stats[entity ? 'resolved' : 'unresolved']++;
          if (c.conflict) stats.conflicts++;
        }
      }
    }
    stats.reasons = Object.fromEntries(
      db
        .prepare(
          "SELECT resolution_reason reason,count(*) n FROM person_sources WHERE namespace='cacbg' AND active=1 GROUP BY resolution_reason",
        )
        .all()
        .map((r) => [r.reason, r.n]),
    );
    stats.revoked = db
      .prepare("SELECT count(*) n FROM person_identity_evidence WHERE decision='revoked'")
      .get().n;
    db.exec('COMMIT');
    return { assignments, stats };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
