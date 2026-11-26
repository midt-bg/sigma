/// <reference types="node" />
// The seats read of the /conflicts list (GOVERNING_SEAT_EIKS_SQL) against a real SQLite built from the
// production migrations.
//
// 1. It returns the companies the join it replaced returned — kept below VERBATIM as the reference — over a
//    fixture with every case the two could part on: a role in each listed seat, roles that are not seats,
//    an entity subject that shares a linked person's identifier, a person the register knows but Sigma has
//    not tied to anybody, two people on one company, one person on several, and one identity behind two
//    declarants.
// 2. It reads from the linked people to their roles by the subject index, never the whole roles table.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GOVERNING_SEAT_EIKS_SQL } from './queries/related-people-list';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// The statement getRegistryRolePersonRows ran before, copied as it was.
const OLD_SQL = `SELECT DISTINCT r.eik FROM registry_roles r JOIN person_registry_links pl ON pl.registry_indent = r.subject_id
          WHERE r.subject_kind = 'person'
            AND r.role IN ('manager','board_of_directors','management_board','governing_body')`;

const ROLES = [
  'manager',
  'board_of_directors',
  'management_board',
  'governing_body',
  'sole_owner',
  'partner',
  'trader',
  'supervisory_board',
  'procurator',
];

let sqlite: DatabaseSync | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
});

function build(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of migrations) db.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  db.exec(`INSERT INTO persons (id, name) VALUES
      ('person:remo', 'Ремо Тестов Груев'), ('person:remo-2', 'Ремо Тестов Груев'),
      ('person:tesa', 'Теса Тестова Ремова'), ('person:unlinked', 'Иво Тестов Петров');
    INSERT INTO person_registry_links (person_id, registry_indent, evidence_link_key, evidence_entry_number, matched_at)
    VALUES ('person:remo', 'hash:remo', 'l1', 'e1', '2026-01-01'),
      ('person:remo-2', 'hash:remo', 'l2', 'e2', '2026-01-01'),
      ('person:tesa', 'hash:tesa', 'l3', 'e3', '2026-01-01');`);
  const role = db.prepare(`INSERT INTO registry_roles
      (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name, entry_number, added_on)
      VALUES (?, ?, '00070', ?, ?, ?, 'Тест', ?, '2020-01-01')`);
  let entry = 0;
  const add = (eik: string, r: string, kind: string, subject: string) =>
    role.run(eik, eik, r, kind, subject, `n${++entry}`);
  // Every role on its own company, for each linked identity and for a subject nobody is tied to.
  ROLES.forEach((r, i) => {
    add(`10000000${i}`, r, 'person', 'hash:remo');
    add(`20000000${i}`, r, 'person', 'hash:tesa');
    add(`30000000${i}`, r, 'person', 'hash:nobody');
    // An entity registered under the same identifier as a linked person is not that person.
    add(`40000000${i}`, r, 'entity', 'hash:remo');
  });
  // Both linked people on one company, and the same seat entered twice.
  add('500000001', 'manager', 'person', 'hash:remo');
  add('500000001', 'board_of_directors', 'person', 'hash:tesa');
  add('500000001', 'manager', 'person', 'hash:remo');
  // Many roles, few links, as in the real register. No ANALYZE: neither D1 base keeps planner statistics, so
  // the planner chooses here from the same nothing it chooses from there.
  for (let i = 0; i < 400; i++)
    add(`6${String(i).padStart(8, '0')}`, 'manager', 'person', `hash:other-${i}`);
  return db;
}

const eiks = (db: DatabaseSync, sql: string) =>
  (db.prepare(sql).all() as { eik: string }[]).map((r) => r.eik).sort();

describe('GOVERNING_SEAT_EIKS_SQL', () => {
  it('returns exactly the companies the join it replaced returned', () => {
    sqlite = build();
    const before = eiks(sqlite, OLD_SQL);
    expect(eiks(sqlite, GOVERNING_SEAT_EIKS_SQL)).toEqual(before);
    // The fixture reaches every case: four seats for each linked identity, the shared company once.
    expect(before).toEqual([
      '100000000',
      '100000001',
      '100000002',
      '100000003',
      '200000000',
      '200000001',
      '200000002',
      '200000003',
      '500000001',
    ]);
  });

  it('stays equal as people are tied to the register and untied', () => {
    sqlite = build();
    sqlite.exec(`DELETE FROM person_registry_links WHERE person_id = 'person:remo'`);
    expect(eiks(sqlite, GOVERNING_SEAT_EIKS_SQL)).toEqual(eiks(sqlite, OLD_SQL));
    sqlite.exec(`DELETE FROM person_registry_links`);
    expect(eiks(sqlite, GOVERNING_SEAT_EIKS_SQL)).toEqual([]);
    expect(eiks(sqlite, OLD_SQL)).toEqual([]);
  });

  it('reads from the linked people to their roles by the subject index', () => {
    sqlite = build();
    const planOf = (sql: string) =>
      (sqlite!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(
        (r) => r.detail,
      );
    // The join it replaced walked the whole roles table, as it does on the real base.
    expect(planOf(OLD_SQL)[0]).toMatch(/^SCAN r\b/);
    const plan = planOf(GOVERNING_SEAT_EIKS_SQL);
    expect(plan[0]).toMatch(/^SCAN pl\b/);
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH r USING INDEX idx_registry_roles_subject/),
    );
    expect(plan.some((d) => /^SCAN r\b/.test(d))).toBe(false);
  });
});
