// Offline bridge: an already-published SELF ownership claim, its exact registration entry,
// the same company and a unique full-name registry subject. Family interests never identify the declarant.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { declarantNameKey } from './source-identity.mjs';

const nameKey = (name) =>
  String(name ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleUpperCase('bg')
    .replace(/\s+/g, ' ');
export function buildPersonRegistryLinks(db, registry, now = new Date().toISOString()) {
  db.exec(
    fs.readFileSync(
      new URL('../../packages/db/migrations/0014_person_profile.sql', import.meta.url),
      'utf8',
    ),
  );
  const links = db
    .prepare(
      `SELECT il.person_id, p.name, il.eik, il.link_key, ev.entry_number
    FROM interest_links il JOIN persons p ON p.id=il.person_id
    JOIN interest_link_evidence ev ON ev.link_key=il.link_key
    WHERE il.status='published' AND il.interest_class='private_ownership' AND il.relation<>'related'
      AND ev.evidence_kind='document' AND ev.entry_number IS NOT NULL`,
    )
    .all();
  const candidates = new Map();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='declaration_identity_evidence'").get()) {
    const sourceProofs = db
      .prepare(
        `SELECT d.person_id, e.* FROM declaration_identity_evidence e
      JOIN declarations d ON d.id=e.declaration_id ORDER BY d.person_id,e.declaration_id,e.eik`,
      )
      .all();
    const sameCompany =
      registry.prepare(`SELECT subject_id,subject_name,entry_number FROM registry_roles
      WHERE eik=? AND subject_kind='person' AND role IN ('partner','sole_owner','trader','manager')`);
    for (const proof of sourceProofs) {
      const rows = sameCompany.all(proof.eik);
      const name = declarantNameKey(proof.document_name);
      if (
        !rows.some(
          (r) =>
            String(r.subject_id).toLowerCase() === proof.registry_indent &&
            r.entry_number === proof.entry_number &&
            declarantNameKey(r.subject_name) === name,
        )
      )
        throw new Error(`Source identity has no matching registry entry: ${proof.declaration_id}`);
      const listed = JSON.parse(proof.listed_names);
      if (!Array.isArray(listed) || !listed.length)
        throw new Error('Identity proof has no listing names');
      const aliases = [...new Set(listed.map(declarantNameKey))];
      if (aliases.some((alias) => alias !== name)) {
        const documentProofs = sourceProofs.filter(
          (p) => p.declaration_id === proof.declaration_id,
        );
        const allIds = new Set(documentProofs.map((p) => p.registry_indent));
        const aliasProven =
          allIds.size === 1 &&
          documentProofs.some((p) => {
            const companyRows = sameCompany.all(p.eik);
            return [name, ...aliases].every((alias) => {
              const ids = new Set(
                companyRows
                  .filter(
                    (r) =>
                      declarantNameKey(r.subject_name) === alias &&
                      /^[a-f0-9]{64}$/i.test(r.subject_id),
                  )
                  .map((r) => r.subject_id.toLowerCase()),
              );
              return ids.size === 1 && ids.has(proof.registry_indent);
            });
          });
        if (!aliasProven) throw new Error(`Unproven listing alias: ${proof.declaration_id}`);
      }
      const group = candidates.get(proof.person_id) ?? [];
      group.push({
        indent: proof.registry_indent,
        eik: proof.eik,
        link_key: `declaration:${proof.declaration_id}`,
        entry_number: proof.entry_number,
      });
      candidates.set(proof.person_id, group);
    }
  }
  const roles = registry.prepare(`SELECT DISTINCT subject_id, subject_name FROM registry_roles
    WHERE eik=? AND entry_number=? AND subject_kind='person' AND role IN ('partner','sole_owner','trader','manager')`);
  for (const link of links) {
    const key = nameKey(link.name);
    if (key.split(' ').length < 3) continue;
    const matches = roles
      .all(link.eik, link.entry_number)
      .filter((r) => /^[a-f0-9]{64}$/i.test(r.subject_id) && nameKey(r.subject_name) === key);
    const ids = [...new Set(matches.map((r) => r.subject_id))];
    const group = candidates.get(link.person_id) ?? [];
    for (const indent of ids) group.push({ ...link, indent });
    candidates.set(link.person_id, group);
  }
  let linked = 0,
    ambiguous = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM person_registry_links');
    const insert = db.prepare('INSERT INTO person_registry_links VALUES(?,?,?,?,?)');
    for (const [id, matches] of candidates) {
      const ids = new Set(matches.map((m) => m.indent));
      if (ids.size !== 1) {
        if (ids.size > 1) ambiguous++;
        continue;
      }
      const m = matches.sort(
        (a, b) =>
          a.link_key.localeCompare(b.link_key) || a.entry_number.localeCompare(b.entry_number),
      )[0];
      insert.run(id, m.indent, m.link_key, m.entry_number, now);
      linked++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { examined: links.length, linked, ambiguous };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
  if (!process.argv.includes('--db') || !process.argv.includes('--registry-db'))
    throw new Error('--db and --registry-db local files are required');
  const db = new DatabaseSync(resolve(arg('--db')));
  const registry = new DatabaseSync(resolve(arg('--registry-db')), { readOnly: true });
  try {
    console.log(JSON.stringify(buildPersonRegistryLinks(db, registry)));
  } finally {
    db.close();
    registry.close();
  }
}
