// Compatibility projection for existing reads. All decisions are made once by person-entities.mjs.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function buildPersonRegistryLinks(db, _registry, now = new Date().toISOString()) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM person_registry_links');
    db.prepare(
      `INSERT INTO person_registry_links(person_id,registry_indent,evidence_link_key,evidence_entry_number,matched_at)
      SELECT p.id,e.registry_indent,'person-entity:'||e.id,'',? FROM persons p
      JOIN person_entities e ON e.id=p.id WHERE e.registry_indent IS NOT NULL
      AND EXISTS(SELECT 1 FROM person_sources s WHERE s.entity_id=e.id AND s.namespace='cacbg' AND s.active=1)`,
    ).run(now);
    const linked = db.prepare('SELECT count(*) n FROM person_registry_links').get().n;
    db.exec('COMMIT');
    return { linked };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--db');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--db local file required');
  const db = new DatabaseSync(resolve(process.argv[i + 1]));
  try {
    console.log(JSON.stringify(buildPersonRegistryLinks(db)));
  } finally {
    db.close();
  }
}
