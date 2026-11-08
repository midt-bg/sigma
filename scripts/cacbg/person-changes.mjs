// Observe identity movement across rebuilds. This report never authorizes a merge or blocks a run.
// It carries source locators and internal person ids, never people's names or registry identifiers.
import { writeFileSync } from 'node:fs';

export function personSnapshot(db) {
  const has = (table) => db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table);
  return {
    sources: has('person_sources')
      ? db
          .prepare(
            "SELECT id,entity_id FROM person_sources WHERE namespace='cacbg' AND active=1 AND entity_id IS NOT NULL ORDER BY id",
          )
          .all()
      : [],
    links: has('interest_links')
      ? db
          .prepare(
            "SELECT link_key,person_id,eik,relation,interest_class,first_declared_year,last_declared_year,publish_tier FROM interest_links WHERE status='published' ORDER BY link_key",
          )
          .all()
      : [],
    offices: has('declarations')
      ? db.prepare('SELECT id,institution FROM declarations ORDER BY id').all()
      : [],
  };
}

export function comparePersons(before, after) {
  const oldSources = new Map(before.sources.map((s) => [s.id, s.entity_id]));
  const newSources = new Map(after.sources.map((s) => [s.id, s.entity_id]));
  const forward = new Map(),
    backward = new Map();
  let moved = 0;
  for (const [id, old] of oldSources) {
    const next = newSources.get(id);
    if (!next) continue;
    if (old !== next) moved++;
    for (const [map, key, value] of [
      [forward, old, next],
      [backward, next, old],
    ]) {
      const set = map.get(key) ?? new Set();
      set.add(value);
      map.set(key, set);
    }
  }
  const multiple = (map) =>
    [...map]
      .filter(([, ids]) => ids.size > 1)
      .map(([person, ids]) => ({ person, counterparts: [...ids].sort() }));
  const oldLinks = new Map(before.links.map((l) => [l.link_key, l]));
  const newLinks = new Map(after.links.map((l) => [l.link_key, l]));
  const oldOffices = new Map(before.offices.map((o) => [o.id, o.institution]));
  return {
    movedDocuments: moved,
    addedDocuments: [...newSources.keys()].filter((id) => !oldSources.has(id)).length,
    removedDocuments: [...oldSources.keys()].filter((id) => !newSources.has(id)).length,
    splits: multiple(forward),
    merges: multiple(backward),
    // A rekey appears on both sides intentionally: it must be visible, never silently treated as equal.
    removedPublishedLinks: before.links.filter((l) => !newLinks.has(l.link_key)),
    addedPublishedLinks: after.links.filter((l) => !oldLinks.has(l.link_key)),
    changedPublishedLinks: after.links.filter(
      (l) =>
        oldLinks.has(l.link_key) &&
        [
          'person_id',
          'eik',
          'relation',
          'interest_class',
          'first_declared_year',
          'last_declared_year',
          'publish_tier',
        ].some((f) => oldLinks.get(l.link_key)[f] !== l[f]),
    ),
    changedOffices: after.offices
      .filter((o) => oldOffices.has(o.id) && oldOffices.get(o.id) !== o.institution)
      .map((o) => ({ declaration: o.id })),
  };
}

export function reportPersonChanges(before, db, file, log = console.log) {
  const report = comparePersons(before, personSnapshot(db));
  writeFileSync(file, JSON.stringify(report, null, 2));
  const summary = Object.fromEntries(
    Object.entries(report).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]),
  );
  log(JSON.stringify({ event: 'declarations_person_changes', ...summary }));
  for (const kind of [
    'splits',
    'merges',
    'removedPublishedLinks',
    'addedPublishedLinks',
    'changedPublishedLinks',
    'changedOffices',
  ])
    for (const change of report[kind])
      log(JSON.stringify({ event: 'declarations_person_change', kind, ...change }));
  return report;
}
