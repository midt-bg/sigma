// Offline bridge: an already-published SELF ownership claim, its exact registration entry,
// the same company and a unique full-name registry subject. Family interests never identify the declarant.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

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
      const m = matches[0];
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
