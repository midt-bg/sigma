import { declarantNameKey } from './source-identity.mjs';

/** Relatives the register confirms: for each published family stake, a holder of the declared company
 * whose three names are those the declaration itself gives for the stake's holder. Names alone never
 * decide anything else here — the declared company and the register's own record do. */
export function buildPersonRelatives(db) {
  const rows = db
    .prepare(
      `SELECT DISTINCT il.person_id, il.eik, rp.related_name, r.subject_id indent,
        COALESCE(p.name, r.subject_name) registry_name
      FROM interest_links il
      JOIN interest_link_observations o ON o.link_key=il.link_key
      JOIN related_persons_internal rp ON rp.declaration_id=o.declaration_id AND rp.related_kind='stake_holder'
      JOIN registry_roles r ON r.eik=il.eik AND r.subject_kind='person' AND r.subject_id NOT LIKE 'local:%'
      LEFT JOIN registry_persons p ON p.indent=r.subject_id
      WHERE il.status='published' AND il.interest_class='family_ownership'`,
    )
    .all();
  db.exec('DELETE FROM person_relatives');
  const insert = db.prepare('INSERT OR IGNORE INTO person_relatives VALUES(?,?,?,?)');
  let linked = 0;
  for (const r of rows) {
    const key = declarantNameKey(r.related_name);
    if (key.split(' ').length < 3 || key !== declarantNameKey(r.registry_name)) continue;
    linked += insert.run(r.person_id, r.indent, r.eik, r.registry_name).changes;
  }
  return linked;
}
