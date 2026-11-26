/// <reference types="node" />
// The ranked search read against a real SQLite built from the production migrations.
//
// 1. It returns what the statements it replaced returned: a COUNT … GROUP BY kind and one
//    `kind = ? … ORDER BY rank LIMIT ?` statement per kind. Those are kept below VERBATIM as the reference.
//    The fixture is built for the cases where the two could part: bm25 ties (rows with the same title rank
//    the same), a tie straddling the company pool's edge, a rare kind behind many matches of another, and
//    kinds whose rows interleave in the index the way the refresh leaves them.
// 2. search() over it keeps every hiding rule of the read path: no identifier on a person, and the
//    свързани-лица badge only on a published, sealed ownership link whose company has contracts.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { search, SEARCH_RANKED_SQL, SEARCH_RANKED_SQL_NO_CONFLICT } from './queries/search';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// The statements search() ran before the ranked read, copied as they were.
const OLD_COUNT_SQL = `SELECT kind, COUNT(*) AS n FROM search_index WHERE search_index MATCH ? GROUP BY kind`;
const oldHitsSql = (withConflict: boolean): string => `SELECT search_index.ref, search_index.title,
        search_index.ident, search_index.subtitle, search_index.amount, rank,
        ct.kind AS entity_kind, ct.ownership_kind, ct.eik_valid,
        ${withConflict ? '(cf.eik IS NOT NULL)' : '0'} AS has_conflict
 FROM search_index
 LEFT JOIN company_totals ct
   ON search_index.kind = 'company' AND ct.bidder_id = search_index.ref
 ${
   withConflict
     ? `LEFT JOIN (
   SELECT DISTINCT il.eik FROM interest_links il
   WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
     AND EXISTS (SELECT 1 FROM interest_link_evidence e
                 WHERE e.link_key = il.link_key AND e.evidence_kind IN ('document','confirmed'))
     AND EXISTS (SELECT 1 FROM contracts cc JOIN bidders bb ON bb.id = cc.bidder_id
                 WHERE bb.eik_normalized = il.eik)
 ) cf ON search_index.kind = 'company' AND cf.eik = search_index.ident`
     : ''
 }
 WHERE search_index.kind = ? AND search_index MATCH ?
 ORDER BY rank LIMIT ?`;
const OLD_LIMITS: Record<string, number> = {
  official: 6,
  person: 6,
  authority: 6,
  company: 50,
  contract: 6,
};

// Companies: ТЕСТ ГРУП ЕООД and its badge cases (published+sealed, held, sealed with a withholding rung,
// published+sealed but without a contract, a management role), plus 60 same-named fragments for the pool's
// edge. Contracts: one subject shared by 70 rows (a 70-way bm25 tie), longer subjects that rank lower.
const FIXTURE = `
INSERT INTO authorities (id, name) VALUES ('auth:000000001', 'ОБЩИНА ТЕСТ');
INSERT INTO bidders (id, name, eik_normalized, eik_valid, kind) VALUES
  ('eik:900000001', 'ТЕСТ ГРУП ЕООД', '900000001', 1, 'company'),
  ('eik:900000002', 'ТЕСТ ГРУП ДВЕ ЕООД', '900000002', 1, 'company'),
  ('eik:900000003', 'ТЕСТ ГРУП ТРИ ЕООД', '900000003', 1, 'company'),
  ('eik:900000004', 'ТЕСТ ГРУП ЧЕТИРИ ЕООД', '900000004', 1, 'company'),
  ('eik:900000005', 'ТЕСТ ГРУП ПЕТ ЕООД', '900000005', 1, 'company');
INSERT INTO company_totals (bidder_id, name, kind, ownership_kind, eik, eik_valid, won_eur, contracts, authorities) VALUES
  ('eik:900000001', 'ТЕСТ ГРУП ЕООД', 'company', NULL, '900000001', 1, 1000, 1, 1),
  ('eik:900000002', 'ТЕСТ ГРУП ДВЕ ЕООД', 'company', 'state', '900000002', 1, 900, 1, 1),
  ('eik:900000003', 'ТЕСТ ГРУП ТРИ ЕООД', 'company', NULL, '900000003', 1, 800, 1, 1),
  ('eik:900000004', 'ТЕСТ ГРУП ЧЕТИРИ ЕООД', 'company', NULL, '900000004', 1, 700, 0, 0),
  ('eik:900000005', 'ТЕСТ ГРУП ПЕТ ЕООД', 'company', NULL, '900000005', 1, 600, 1, 1);
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES
  ('t:1', 'UNP-1', 'Ремонт на покрив', 'auth:000000001', 'open');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, amount_eur) VALUES
  ('c:1', 't:1', 'eik:900000001', 1000, 'EUR', '2024-03-01', 1000),
  ('c:2', 't:1', 'eik:900000002', 900, 'EUR', '2024-03-01', 900),
  ('c:3', 't:1', 'eik:900000003', 800, 'EUR', '2024-03-01', 800),
  ('c:5', 't:1', 'eik:900000005', 600, 'EUR', '2024-03-01', 600);
INSERT INTO persons (id, name) VALUES
  ('person:ремо', 'Ремо Тестов Груев'), ('person:теса', 'Теса Тестова Ремова');
INSERT INTO declarations (id, person_id, xml_file, folder_year, declared_year, template, institution, position,
                          source_url) VALUES
  ('decl:r1', 'person:ремо', 'r1.xml', '2024', '2023', 'assets', 'ОБЩИНА ТЕСТ', 'Кмет',
   'https://register.cacbg.bg/2024/r1.xml');
INSERT INTO interest_links (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version,
                            publish_tier, relation, interest_class, first_declared_year, last_declared_year,
                            contract_count, status) VALUES
  ('il:1', 'person:ремо|900000001', 'person:ремо', 'eik:900000001', '900000001', 'ТЕСТ ГРУП',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', '2023', '2023', 1, 'published'),
  ('il:2', 'person:ремо|900000002|family', 'person:ремо', 'eik:900000002', '900000002', 'ТЕСТ ГРУП ДВЕ',
   'declared_eik', 'v1', 'A_eik', 'related', 'family_ownership', '2023', '2023', 1, 'published'),
  ('il:3', 'person:ремо|900000003', 'person:ремо', 'eik:900000003', '900000003', 'ТЕСТ ГРУП ТРИ',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', '2023', '2023', 1, 'held'),
  ('il:4', 'person:ремо|900000004', 'person:ремо', 'eik:900000004', '900000004', 'ТЕСТ ГРУП ЧЕТИРИ',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', '2023', '2023', 0, 'published'),
  ('il:5', 'person:теса|900000005', 'person:теса', 'eik:900000005', '900000005', 'ТЕСТ ГРУП ПЕТ',
   'declared_eik', 'v1', 'A_eik', 'manages', 'management_role', '2023', '2023', 1, 'published'),
  ('il:6', 'person:теса|900000003', 'person:теса', 'eik:900000003', '900000003', 'ТЕСТ ГРУП ТРИ',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', '2023', '2023', 1, 'published');
INSERT INTO interest_link_evidence (link_key, evidence_kind, lookup_date, rules_version, live_status) VALUES
  ('person:ремо|900000001', 'document', '2026-09-01', 'tr-rules-1', 'live'),
  ('person:ремо|900000002|family', 'confirmed', '2026-09-01', 'tr-rules-1', 'live'),
  ('person:ремо|900000003', 'document', '2026-09-01', 'tr-rules-1', 'live'),
  ('person:ремо|900000004', 'document', '2026-09-01', 'tr-rules-1', 'live'),
  ('person:теса|900000005', 'document', '2026-09-01', 'tr-rules-1', 'live'),
  ('person:теса|900000003', 'document_uncorroborated', '2026-09-01', 'tr-rules-1', 'live');
`;

// Index rows, interleaved by kind. An official's `ident` holds the names of its sources in production; the
// read must never pass it on.
function indexRows(sqlite: DatabaseSync): void {
  const insert = sqlite.prepare(
    'INSERT INTO search_index (kind, ref, title, ident, subtitle, amount) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const companies = [1, 2, 3, 4, 5].map(
    (i) =>
      sqlite
        .prepare('SELECT bidder_id, name, eik, won_eur FROM company_totals WHERE bidder_id = ?')
        .get(`eik:90000000${i}`) as {
        bidder_id: string;
        name: string;
        eik: string;
        won_eur: number;
      },
  );
  for (let i = 0; i < 70; i++) {
    insert.run(
      'contract',
      `c:tie:${i}`,
      'Ремонт на покрив',
      `UNP-${i}`,
      'ОБЩИНА ТЕСТ → ТЕСТ',
      100 + i,
    );
    if (i % 3 === 0)
      insert.run(
        'contract',
        `c:long:${i}`,
        'Ремонт на покрив и улица в село Тест',
        `UNP-L${i}`,
        '',
        i,
      );
    if (i < 60) insert.run('company', `name:ТЕСТ ГРУП ${i % 2}`, 'ТЕСТ ГРУП', '', '', i);
    if (i < 5) {
      const c = companies[i]!;
      insert.run('company', c.bidder_id, c.name, c.eik, '', c.won_eur);
    }
    if (i === 40)
      insert.run('official', 'person:ремо', 'Ремо Тестов Груев', 'Ремо Тестов Груев', 'Кмет', 1000);
    if (i % 10 === 5)
      insert.run(
        'person',
        `person:тест:${i}`,
        `Тест Ремонтов ${i}`,
        'скрит идентификатор',
        null,
        null,
      );
    if (i === 69)
      insert.run('authority', 'auth:000000001', 'ОБЩИНА ТЕСТ', '000000001', 'Тест', 5000);
  }
}

let open: DatabaseSync | null = null;
function built(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of migrations) sqlite.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  sqlite.exec(FIXTURE);
  indexRows(sqlite);
  open = sqlite;
  return sqlite;
}
afterEach(() => {
  open?.close();
  open = null;
});

type Row = Record<string, unknown>;
// The reference: what the count and per-kind statements returned, per kind, in their order.
function before(sqlite: DatabaseSync, match: string, withConflict: boolean) {
  const counts = Object.fromEntries(
    (sqlite.prepare(OLD_COUNT_SQL).all(match) as Row[]).map((r) => [r.kind, r.n]),
  );
  const hits = Object.fromEntries(
    Object.entries(OLD_LIMITS)
      .filter(([kind]) => counts[kind])
      .map(([kind, limit]) => [
        kind,
        sqlite.prepare(oldHitsSql(withConflict)).all(kind, match, limit) as Row[],
      ]),
  );
  return { counts, hits };
}
function after(sqlite: DatabaseSync, match: string, withConflict: boolean) {
  const rows = sqlite
    .prepare(withConflict ? SEARCH_RANKED_SQL : SEARCH_RANKED_SQL_NO_CONFLICT)
    .all(match) as Row[];
  const counts: Row = {};
  const hits: Record<string, Row[]> = {};
  for (const { kind, n, rn, ...hit } of rows) {
    counts[kind as string] = n;
    expect(rn).toBe((hits[kind as string] ??= []).length + 1);
    hits[kind as string]!.push(hit);
  }
  return { counts, hits };
}

const MATCHES = [
  'ремонт*',
  'ре*',
  'покрив* ремонт*',
  'тест*',
  'тест* груп*',
  'груп*',
  'еоод*',
  'ремо*',
  'ул*',
];

describe('the ranked read returns what the per-kind statements returned', () => {
  it.each(MATCHES)(
    '%s — same counts, same rows in the same order, with and without the badge',
    (m) => {
      const sqlite = built();
      for (const withConflict of [true, false]) {
        const want = before(sqlite, m, withConflict);
        const got = after(sqlite, m, withConflict);
        expect(got.counts).toEqual(want.counts);
        expect(got.hits).toEqual(want.hits);
      }
    },
  );

  it('the fixture holds the cases it is meant to', () => {
    const sqlite = built();
    // A 70-way bm25 tie inside the contracts…
    const repair = before(sqlite, 'ремонт*', true);
    expect(new Set((repair.hits.contract as Row[]).map((r) => r.rank)).size).toBe(1);
    expect(repair.counts.contract).toBeGreaterThan(70);
    // …a tie across the company pool's edge, and a rare kind behind many matches of the others.
    const { counts, hits } = before(sqlite, 'тест*', true);
    expect(counts.company).toBeGreaterThan(50);
    expect((hits.company as Row[])[49]!.rank).toBe(
      (
        sqlite
          .prepare(
            "SELECT rank FROM search_index WHERE kind = 'company' AND search_index MATCH 'тест*' ORDER BY rank LIMIT 1 OFFSET 50",
          )
          .get() as Row
      ).rank,
    );
    expect(counts.official).toBe(1);
  });
});

describe('search() over the ranked read keeps the hiding rules', () => {
  it('never shows a person’s identifier, and badges only a published, sealed ownership link with contracts', async () => {
    const results = await search(d1FromSqlite(built()), 'тест');
    const people = results.groups.find((g) => g.kind === 'official')!;
    // The official, then six of the seven other people (the group's limit).
    expect(people.hits.map((h) => h.kind)).toEqual(['official', ...Array(6).fill('person')]);
    for (const hit of people.hits) expect(hit.ident).toBeNull();

    const companies = (await search(d1FromSqlite(built()), 'тест груп еоод')).groups.find(
      (g) => g.kind === 'company',
    )!;
    const badge = Object.fromEntries(companies.hits.map((h) => [h.title, h.hasConflict]));
    expect(badge).toMatchObject({
      'ТЕСТ ГРУП ЕООД': true, // published, sealed (document), own stake, contracts
      'ТЕСТ ГРУП ДВЕ ЕООД': true, // published, sealed (confirmed), a relative's stake
      'ТЕСТ ГРУП ТРИ ЕООД': false, // held; another link sealed only by a withholding rung
      'ТЕСТ ГРУП ЧЕТИРИ ЕООД': false, // published and sealed, but the company has no contract
      'ТЕСТ ГРУП ПЕТ ЕООД': false, // a management role is never a declared stake
    });
  });

  it('the official keeps the office line from the filings and the identifier stays out', async () => {
    const results = await search(d1FromSqlite(built()), 'ремо тестов');
    const people = results.groups.find((g) => g.kind === 'official')!;
    expect(people.hits[0]).toMatchObject({ kind: 'official', ident: null });
    expect(people.hits[0]!.subtitle).toContain('ОБЩИНА ТЕСТ');
  });
});
