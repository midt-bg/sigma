import { declarantNameKey } from './source-identity.mjs';
import { personNamesAlike } from '../../packages/shared/src/person-identity.ts';

/** Relatives the register confirms: for each published family stake, a holder of the declared company
 * whose name is the one the declaration itself gives for the stake's holder — the exact spelling, else a
 * variant (evidence.mjs), and only when it fits one registered person. Names alone never decide anything
 * else here — the declared company and the register's own record do. */
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
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.person_id, r.eik, declarantNameKey(r.related_name)]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  db.exec('DELETE FROM person_relatives');
  const insert = db.prepare('INSERT OR IGNORE INTO person_relatives VALUES(?,?,?,?)');
  let linked = 0;
  for (const group of groups.values()) {
    const name = group[0].related_name;
    const exact = group.filter((r) => declarantNameKey(r.registry_name) === declarantNameKey(name));
    const fits = exact.length
      ? exact
      : group.filter((r) => personNamesAlike(name, r.registry_name));
    if (declarantNameKey(name).split(' ').length < 3) continue;
    if (new Set(fits.map((r) => r.indent)).size !== 1) continue;
    linked += insert.run(
      fits[0].person_id,
      fits[0].indent,
      fits[0].eik,
      fits[0].registry_name,
    ).changes;
  }
  return linked;
}
