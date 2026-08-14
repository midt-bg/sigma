/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1 = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2 = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const migration3 = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
const migration9 = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');
const migration10 = resolve(root, 'packages/db/migrations/0010_publishing_gate_constraints.sql');
const backfill = resolve(root, 'scripts/backfill-current-value-currency.sql');
const precompute = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

describe('served migrations', () => {
  // 0000_init remains the complete base served schema. Later migrations must be additive over that
  // base so initial setup (`wrangler d1 migrations apply`) and ETL ships keep the same table shape.
  it('builds the served schema from the migration chain', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      readScript(dbPath, migration1);
      readScript(dbPath, migration2);

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='amendments';",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='contract_co_authorities';",
        ).trim(),
      ).toBe('1');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='authority_joint_participation';",
        ).trim(),
      ).toBe('1');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('amendments') WHERE name='natural_key' AND \"notnull\"=1;",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='parties';",
        ).trim(),
      ).toBe('1');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('parties') WHERE name='party_key' AND pk=1;",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('tenders') WHERE name='eop_tender_id';",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_flow_pairs_bidder' AND tbl_name='flow_pairs';",
        ).trim(),
      ).toBe('1');

      // The served schema must never carry raw_* staging tables.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'raw_%';").trim(),
      ).toBe('0');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('contracts') WHERE name='current_value_currency';",
        ).trim(),
      ).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills cross-currency amendment amounts and their rollups', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migration-backfill-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      readScript(dbPath, migration1);
      sqlite(
        dbPath,
        `INSERT INTO authorities (id, name) VALUES ('auth:1', 'Authority');
         INSERT INTO bidders (id, name, kind) VALUES ('eik:1', 'Bidder', 'company');
         INSERT INTO tenders
           (id, source_id, title, authority_id, cpv_code, procedure_type, status)
         VALUES
           ('t:UNP-1', 'UNP-1', 'Tender', 'auth:1', '45000000', 'open', 'awarded');
         INSERT INTO contracts
           (id, tender_id, bidder_id, amount, currency, contract_number, signing_value,
            current_value, value_flag, amount_eur, current_value_eur)
         VALUES
           ('c:e:1', 't:UNP-1', 'eik:1', 104748559.44, 'BGN', 'CONTRACT-1',
            136580250, 104748559.44, 'ok', 104748559.44 / 1.95583,
            104748559.44 / 1.95583);
         INSERT INTO amendments
           (id, natural_key, contract_number, unp, value_after, currency, published_at, source)
         VALUES
           ('am:1', 'am:1', 'CONTRACT-1', 'UNP-1', 104748559.44, 'EUR',
            '2026-06-03', 'eop:annexes:2026-06-01');`,
      );
      readScript(dbPath, migration2);
      readScript(dbPath, migration3);
      readScript(dbPath, migration9);
      readScript(dbPath, backfill);
      readScript(dbPath, precompute);

      expect(
        sqlite(
          dbPath,
          "SELECT printf('%.2f', amount_eur) || '|' || printf('%.2f', current_value_eur) || '|' || current_value_currency FROM contracts;",
        ).trim(),
      ).toBe('104748559.44|104748559.44|EUR');
      expect(sqlite(dbPath, "SELECT printf('%.2f', value_eur) FROM home_totals;").trim()).toBe(
        '104748559.44',
      );
      expect(sqlite(dbPath, "SELECT printf('%.2f', won_eur) FROM flow_pairs;").trim()).toBe(
        '104748559.44',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 0006 attaches the Trade Register evidence seal to a link (#279, ADR-0033). A SIDE TABLE rather than
  // columns on interest_links, for two reasons that are easy to forget: SQLite's ADD COLUMN has no
  // IF NOT EXISTS and migrations are applied by a bare `d1 execute --file` with no tracking, so a
  // re-apply must be a no-op; and load.mjs rebuilds the CACBG tables from 0003 alone, so any column
  // added here would have to be duplicated into 0003 and kept in step forever.
  it('0006 adds the evidence seal and re-applying it is a no-op', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-0006-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const m of [migration0, migration1, migration2, migration3, migration9])
        readScript(dbPath, m);

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='interest_link_evidence';",
        ).trim(),
      ).toBe('1');

      // A seal for a real link survives a second apply — the migration must not drop and recreate.
      sqlite(
        dbPath,
        `INSERT INTO persons (id, name) VALUES ('person:a', 'Иван Петров Тестов');
         INSERT INTO bidders (id, name, eik_normalized, eik_valid)
           VALUES ('eik:201122335', 'АЛФА СТРОЙ ООД', '201122335', 1);
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
            relation, interest_class, status)
         VALUES ('il:k', 'k', 'person:a', 'eik:201122335', '201122335', 'АЛФА СТРОЙ ООД',
                 'test', 'document', 'owns', 'private_ownership', 'published');
         INSERT INTO interest_link_evidence
           (link_key, evidence_kind, matched_fact, lookup_date, rules_version, live_status)
         VALUES ('k', 'document', 'role:owner:CR_F_19_L', '2026-08-05', 'tr-rules-1', 'live');`,
      );
      readScript(dbPath, migration9); // idempotent re-apply
      expect(sqlite(dbPath, 'SELECT COUNT(*) FROM interest_link_evidence;').trim()).toBe('1');

      // The FK is real: a seal for a link that does not exist is rejected. D1 enforces foreign keys,
      // so this is what stops the ship path inserting seals before (or after wiping) their links.
      expect(() =>
        sqlite(
          dbPath,
          `PRAGMA foreign_keys=ON;
           INSERT INTO interest_link_evidence
             (link_key, evidence_kind, matched_fact, lookup_date, rules_version, live_status)
           VALUES ('nope', 'document', 'eik', '2026-08-05', 'tr-rules-1', 'live');`,
        ),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #279 §2: the publishing gate reads these columns as enums, but the schema let them hold anything.
  // A value that merely LOOKS like a gate value — the trailing space in 'published ' §2 names — passes
  // every writer and then silently fails `status = 'published'` (or worse, passes a LIKE somewhere).
  // A CHECK is the only place this can be enforced for every writer at once, including a hand-run UPDATE.
  it('constrains the publishing-gate enums and the declaration identity key', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const m of [migration0, migration3, migration9, migration10]) readScript(dbPath, m);

      const seedLink = (status: string) =>
        sqlite(
          dbPath,
          `INSERT INTO persons(id, name) VALUES ('person:a', 'А') ON CONFLICT DO NOTHING;
           INSERT INTO interest_links
             (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
              relation, interest_class, status)
           VALUES ('il:${status}', '${status}', 'person:a', 'eik:201122335', '201122335',
                   'АЛФА СТРОЙ ООД', 'test', 'document', 'owns', 'private_ownership', '${status}');`,
        );

      // §2's named case: 'published ' is not 'published'. It must be rejected, not stored.
      expect(() => seedLink('published ')).toThrow(/CHECK/i);
      expect(() => seedLink('publushed')).toThrow(/CHECK/i);
      // POSITIVE CONTROL — every real status still inserts. A CHECK that rejected everything would pass
      // the assertions above while breaking the loader.
      for (const s of ['published', 'held', 'withdrawn', 'suppressed', 'internal'])
        expect(() => seedLink(s)).not.toThrow();

      // interest_class gates the surface just as hard: a non-surfaced class is what keeps a management
      // role off the public page, so a typo'd class is a leak in the same way.
      expect(() =>
        sqlite(
          dbPath,
          `INSERT INTO interest_links
             (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
              relation, interest_class, status)
           VALUES ('il:c', 'c', 'person:a', 'eik:1', '1', 'X', 't', 'document', 'owns',
                   'private_ownership ', 'held');`,
        ),
      ).toThrow(/CHECK/i);

      // evidence_kind decides whether a link may be read at all (SURFACED_OWNERSHIP). ADR-0035's
      // document_uncorroborated must be a legal value — and a misspelling must not be.
      const seal = (kind: string) =>
        sqlite(
          dbPath,
          `INSERT INTO interest_link_evidence
             (link_key, evidence_kind, lookup_date, rules_version, live_status)
           VALUES ('${kind}', '${kind}', '2026-08-12', 'tr-rules-1', 'live');`,
        );
      expect(() => seal('document_uncorroberated')).toThrow(/CHECK|FOREIGN KEY/i);
      for (const k of ['document', 'confirmed', 'document_uncorroborated', 'refuted'])
        expect(() => {
          sqlite(
            dbPath,
            `INSERT INTO interest_links
               (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
                relation, interest_class, status)
             VALUES ('il:${k}', '${k}', 'person:a', 'eik:1', '1', 'X', 't', '${k}', 'owns',
                     'private_ownership', 'held');
             INSERT INTO interest_link_evidence
               (link_key, evidence_kind, lookup_date, rules_version, live_status)
             VALUES ('${k}', '${k}', '2026-08-12', 'tr-rules-1', 'live');`,
          );
        }).not.toThrow();

      // §2: `UNIQUE (xml_file, control_hash)` did not constrain re-import. SQLite counts NULLs as
      // DISTINCT and control_hash is genuinely optional at the source, so two hashless imports of the
      // SAME declaration both inserted and double-counted the stakes it carries.
      const decl = (id: string, hash: string | null, folder = '2023') =>
        sqlite(
          dbPath,
          `INSERT INTO declarations
             (id, person_id, xml_file, control_hash, folder_year, template, source_url)
           VALUES ('${id}', 'person:a', 'A.xml', ${hash === null ? 'NULL' : `'${hash}'`},
                   '${folder}', 'assets', 'https://x/A.xml');`,
        );
      expect(() => decl('d:n1', null)).not.toThrow();
      expect(() => decl('d:n2', null)).toThrow(/UNIQUE/i); // the case that used to slip through
      expect(() => decl('d:1', 'H1')).not.toThrow();
      expect(() => decl('d:2', 'H1')).toThrow(/UNIQUE/i);
      // POSITIVE CONTROLS — the key must not over-constrain. The register reuses basenames across
      // FOLDERS, so the same xml_file in a different folder is a DIFFERENT declaration (load.mjs
      // namespaces its id for this reason), and a genuinely different hash is a corrected re-filing.
      expect(() => decl('d:f2', null, '2024')).not.toThrow();
      expect(() => decl('d:3', 'H2')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE POINT OF 0007, stated as an executable claim rather than a comment (todorkolev, #309).
  //
  // 0003 is an ALREADY-APPLIED migration and is therefore never edited: `CREATE TABLE IF NOT EXISTS` is a
  // no-op on a live database, so an in-place CHECK would exist only on freshly built ones. That would put
  // two different schemas under one name — and the divergence would land precisely on the served database,
  // which is where a hand-run `UPDATE status='published '` during an incident actually happens.
  //
  // So 0007 owns the enforcement for BOTH shapes, and this test is what keeps them one shape: a fresh
  // 0000..0007 build and a legacy database retrofitted by 0007 must reject the SAME values and accept the
  // SAME values. If either drifts, the parity assertions below fail rather than a reviewer noticing.
  it('a fresh build and a retrofitted legacy database enforce the SAME gate', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-parity-'));
    const fresh = resolve(dir, 'fresh.sqlite');
    const legacy = resolve(dir, 'legacy.sqlite');
    try {
      // (1) fresh: the migration chain exactly as a new environment applies it.
      for (const m of [migration0, migration3, migration9, migration10]) readScript(fresh, m);

      // (2) legacy: 0003 + 0006 as they were BEFORE this PR, then 0007 retrofits. `interest_links` is
      // recreated without constraints because that is the shape every already-deployed database holds.
      for (const m of [migration0, migration3, migration9]) readScript(legacy, m);
      sqlite(
        legacy,
        `DROP TABLE interest_link_evidence;
         DROP TABLE interest_links;
         CREATE TABLE interest_links (
           id TEXT PRIMARY KEY, link_key TEXT NOT NULL UNIQUE,
           person_id TEXT NOT NULL REFERENCES persons(id), bidder_id TEXT NOT NULL, eik TEXT NOT NULL,
           entity_key TEXT NOT NULL, match_method TEXT, matcher_version TEXT NOT NULL,
           publish_tier TEXT NOT NULL, relation TEXT NOT NULL,
           interest_class TEXT NOT NULL DEFAULT 'management_role',
           contemporaneous INTEGER NOT NULL DEFAULT 0, own_institution TEXT NOT NULL DEFAULT 'none',
           evidence_count INTEGER NOT NULL DEFAULT 1, first_declared_year TEXT, last_declared_year TEXT,
           contract_count INTEGER NOT NULL DEFAULT 0, contract_value_eur REAL, first_contract_year TEXT,
           last_contract_year TEXT, status TEXT NOT NULL DEFAULT 'held', verified_by TEXT,
           verified_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
         CREATE TABLE interest_link_evidence (
           link_key TEXT PRIMARY KEY REFERENCES interest_links(link_key), evidence_kind TEXT NOT NULL,
           registry_role TEXT, matched_fact TEXT, entry_number TEXT, entry_date TEXT,
           lookup_date TEXT NOT NULL, rules_version TEXT NOT NULL, live_status TEXT NOT NULL,
           sealed_at TEXT NOT NULL DEFAULT (datetime('now')));`,
      );
      readScript(legacy, migration10);

      const link = (db: string, id: string, status: string, cls = 'private_ownership') =>
        sqlite(
          db,
          `INSERT INTO persons(id, name) VALUES ('person:a', 'А') ON CONFLICT DO NOTHING;
           INSERT INTO interest_links
             (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
              relation, interest_class, status)
           VALUES ('il:${id}', '${id}', 'person:a', 'eik:1', '1', 'X', 't', 'document', 'owns',
                   '${cls}', '${status}');`,
        );
      const seal = (db: string, key: string, kind: string) =>
        sqlite(
          db,
          `INSERT INTO interest_link_evidence
             (link_key, evidence_kind, lookup_date, rules_version, live_status)
           VALUES ('${key}', '${kind}', '2026-08-14', 'tr-rules-1', 'live');`,
        );

      for (const [label, db] of [
        ['fresh', fresh],
        ['legacy', legacy],
      ] as const) {
        // REJECTED identically — 'published ' is #279 §2's named case, and it is the one a human types.
        expect(() => link(db, `bad1-${label}`, 'published ')).toThrow(/CHECK/i);
        expect(() => link(db, `bad2-${label}`, 'publushed')).toThrow(/CHECK/i);
        expect(() => link(db, `bad3-${label}`, 'held', 'private_ownership ')).toThrow(/CHECK/i);
        // ACCEPTED identically — the gate is a bound, not a blanket, on both shapes.
        expect(() => link(db, `ok-${label}`, 'published')).not.toThrow();
        expect(() => seal(db, `ok-${label}`, 'document')).not.toThrow();
        expect(() => seal(db, `ok-${label}`, 'document_uncorroborated')).toThrow(/UNIQUE|CHECK/i);
        // …and the evidence enum is enforced on both too.
        expect(() => link(db, `k2-${label}`, 'held')).not.toThrow();
        expect(() => seal(db, `k2-${label}`, 'document_uncorroberated')).toThrow(/CHECK/i);
        // The UPDATE path is the one an incident actually uses, and no CHECK would ever cover it on a
        // legacy table — only the trigger does.
        expect(() =>
          sqlite(db, `UPDATE interest_links SET status='published ' WHERE link_key='ok-${label}';`),
        ).toThrow(/CHECK/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The retrofit has to be safe on a LIVE D1: ship-related-persons wipes rows, never table definitions,
  // so a deployed database keeps its unconstrained 0003 shape until this migration rebuilds it.
  it('0007 retrofits a pre-existing database, keeps its rows, and re-applies as a no-op', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const m of [migration0, migration3, migration9]) readScript(dbPath, m);
      // Simulate a database provisioned BEFORE today: 0003 now declares the constraints, so the legacy
      // shape has to be recreated explicitly. This is the state every already-deployed environment is in
      // — `CREATE TABLE IF NOT EXISTS` never revisited it and ship-related-persons only wipes rows.
      sqlite(
        dbPath,
        `DROP TABLE declarations;
         CREATE TABLE declarations (
           id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), xml_file TEXT NOT NULL,
           control_hash TEXT, folder_year TEXT NOT NULL, declared_year TEXT, template TEXT NOT NULL,
           category TEXT, institution TEXT, position TEXT, source_url TEXT NOT NULL,
           UNIQUE (xml_file, control_hash));
         DROP TABLE interest_links;
         CREATE TABLE interest_links (
           id TEXT PRIMARY KEY, link_key TEXT NOT NULL UNIQUE,
           person_id TEXT NOT NULL REFERENCES persons(id), bidder_id TEXT NOT NULL, eik TEXT NOT NULL,
           entity_key TEXT NOT NULL, match_method TEXT, matcher_version TEXT NOT NULL,
           publish_tier TEXT NOT NULL, relation TEXT NOT NULL,
           interest_class TEXT NOT NULL DEFAULT 'management_role', contemporaneous INTEGER NOT NULL DEFAULT 0,
           own_institution TEXT NOT NULL DEFAULT 'none', evidence_count INTEGER NOT NULL DEFAULT 1,
           first_declared_year TEXT, last_declared_year TEXT, contract_count INTEGER NOT NULL DEFAULT 0,
           contract_value_eur REAL, first_contract_year TEXT, last_contract_year TEXT,
           status TEXT NOT NULL DEFAULT 'held', verified_by TEXT, verified_at TEXT,
           created_at TEXT NOT NULL DEFAULT (datetime('now')));`,
      );
      // The rows the retrofit must preserve — plus the two shapes it must not.
      sqlite(
        dbPath,
        `INSERT INTO persons(id, name) VALUES ('person:a', 'А');
         INSERT INTO declarations
           (id, person_id, xml_file, control_hash, folder_year, template, source_url)
         VALUES ('d:keep', 'person:a', 'K.xml', 'HK', '2023', 'assets', 'https://x/K.xml');
         INSERT INTO declarations
           (id, person_id, xml_file, control_hash, folder_year, template, source_url)
         VALUES ('d:drop', 'person:a', 'D.xml', NULL, '2023', 'assets', 'https://x/D.xml');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
            relation, interest_class, status)
         VALUES ('il:k', 'k', 'person:a', 'eik:1', '1', 'X', 't', 'document', 'owns',
                 'private_ownership', 'published');
         -- The uninterpretable status §2 is about, already stored because nothing rejected it.
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
            relation, interest_class, status)
         VALUES ('il:bad', 'bad', 'person:a', 'eik:1', '1', 'X', 't', 'document', 'owns',
                 'private_ownership', 'published ');`,
      );

      readScript(dbPath, migration10);
      // The valid rows survive — nothing is rebuilt, so nothing can be lost…
      expect(sqlite(dbPath, "SELECT id FROM declarations WHERE id='d:keep';").trim()).toBe(
        'd:keep',
      );
      expect(sqlite(dbPath, "SELECT link_key FROM interest_links WHERE link_key='k';").trim()).toBe(
        'k',
      );
      // …including the pre-existing trailing-space row. A trigger constrains FUTURE writes; it cannot
      // retroactively reject a row already stored, and deleting one would mean dropping a real link on a
      // guess. The loader rewrites the table wholesale on the next run, which is what corrects it — and
      // the read gate never showed it anyway, since 'published ' is not 'published'.
      expect(sqlite(dbPath, 'SELECT COUNT(*) FROM interest_links;').trim()).toBe('2');
      // The hashless row SURVIVES — it is a real declaration and NOT NULL was rejected for that reason —
      // but it is now covered by the natural key, so re-importing it is refused rather than duplicated.
      expect(sqlite(dbPath, "SELECT COUNT(*) FROM declarations WHERE id='d:drop';").trim()).toBe(
        '1',
      );
      expect(() =>
        sqlite(
          dbPath,
          `INSERT INTO declarations
             (id, person_id, xml_file, control_hash, folder_year, template, source_url)
           VALUES ('d:dup', 'person:a', 'D.xml', NULL, '2023', 'assets', 'https://x/D.xml');`,
        ),
      ).toThrow(/UNIQUE/i);
      // …and the constraint is in force for every writer afterwards, on INSERT and on UPDATE alike.
      // UPDATE is the one that matters most: a hand-run status change during an incident is exactly when
      // a stray character gets typed, and it is the path no application-level validation covers.
      expect(() =>
        sqlite(dbPath, "UPDATE interest_links SET status='published ' WHERE link_key='k';"),
      ).toThrow(/CHECK failed/i);
      expect(() =>
        sqlite(
          dbPath,
          `INSERT INTO interest_links
             (id, link_key, person_id, bidder_id, eik, entity_key, matcher_version, publish_tier,
              relation, interest_class, status)
           VALUES ('il:x', 'x', 'person:a', 'eik:1', '1', 'X', 't', 'document', 'owns',
                   'private_ownership', 'publushed');`,
        ),
      ).toThrow(/CHECK failed/i);
      // POSITIVE CONTROL: a legitimate status change still goes through — the trigger is a bound.
      expect(() =>
        sqlite(dbPath, "UPDATE interest_links SET status='withdrawn' WHERE link_key='k';"),
      ).not.toThrow();

      // Migrations here are applied by a bare `d1 execute --file` with no applied-migrations tracking,
      // so a second application MUST be a no-op rather than an error or a data loss.
      readScript(dbPath, migration10);
      expect(sqlite(dbPath, 'SELECT COUNT(*) FROM interest_links;').trim()).toBe('2');
      expect(sqlite(dbPath, "SELECT id FROM declarations WHERE id='d:keep';").trim()).toBe(
        'd:keep',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
