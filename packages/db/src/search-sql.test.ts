/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_HITS_SQL, SEARCH_HITS_SQL_NO_CONFLICT } from './queries/search';

// Integration test for the search-side свързани-лица SQL. The queries/search unit tests use a fake D1 and
// never run the real FTS + joins; this runs the EXACT exported SEARCH_HITS_SQL (which is used for EVERY kind,
// so a syntax slip would break all search) and the officials-index INSERT against a real SQLite built from
// the production migrations. Asserts: the query executes, officials dedupe to one row per person, only
// PUBLISHED links index/flag, and the company badge join keys correctly on the winner's ЕИК.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2 = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
const migration9 = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}
function exec(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}
function lit(sql: string, ...vals: (string | number)[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = vals[i++];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
}
function rows(dbPath: string, sql: string): Record<string, string | number | null>[] {
  const out = execFileSync('sqlite3', ['-json', dbPath], { input: sql, encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

// АЛФА + ГАМА both linked to one official (Иван) → dedupes to a single official row; БЕТА has no PUBLISHED
// link (Георги's link to it is 'held') → БЕТА must NOT be flagged and Георги must NOT be indexed.
const FIXTURE = `
INSERT INTO bidders (id, name, eik_normalized, eik_valid, kind) VALUES
  ('eik:111','АЛФА ООД','111111111',1,'company'),
  ('eik:222','БЕТА ООД','222222222',1,'company'),
  ('eik:333','ГАМА ООД','333333333',1,'company'),
  ('eik:444','ДЕЛТА ООД','444444444',1,'company'),
  ('eik:555','ЕПСИЛОН ООД','555555555',1,'company'),
  ('eik:666','ЗЕТА ООД','666666666',1,'company'),
  -- #279: two winners with a PUBLISHED link that must not badge. ЙОТА's link carries NO evidence seal at
  -- all (a legacy row, a partial run, or a loader bug); КАПА's seal is a WITHHOLDING rung. The detail page
  -- refuses both via SURFACED_OWNERSHIP; the badge has to agree, or search advertises an unproven claim
  -- about a named official on a page that then shows nothing.
  ('eik:777','ЙОТА ООД','777777777',1,'company'),
  ('eik:888','КАПА ООД','888888888',1,'company');
INSERT INTO company_totals (bidder_id, name, kind, eik, eik_valid, won_eur, contracts, authorities) VALUES
  ('eik:111','АЛФА ООД','company','111111111',1,1000000,1,1),
  ('eik:222','БЕТА ООД','company','222222222',1,500000,1,1),
  ('eik:333','ГАМА ООД','company','333333333',1,200000,1,1),
  ('eik:444','ДЕЛТА ООД','company','444444444',1,300000,1,1),
  ('eik:555','ЕПСИЛОН ООД','company','555555555',1,700000,1,1),
  ('eik:666','ЗЕТА ООД','company','666666666',1,900000,1,1),
  ('eik:777','ЙОТА ООД','company','777777777',1,400000,1,1),
  ('eik:888','КАПА ООД','company','888888888',1,600000,1,1);
INSERT INTO persons (id, name) VALUES
  ('person:ИВАН МИНЕВ','Иван Минев'),('person:ГЕОРГИ ПЕТРОВ','Георги Петров'),
  ('person:ДАНА ФАМ','Дана Фам'),('person:БОРИС БОРД','Борис Борд'),('person:ДВОЕН ТЕСТ','Двоен Тест'),
  ('person:БЕЗ ПЕЧАТ','Без Печат'),('person:ЗАДЪРЖАН ПЕЧАТ','Задържан Печат');
INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
  ('decl:i','person:ИВАН МИНЕВ','i.xml','H1','2024','2023','assets','','ОБЩИНА РУСЕ','', 'https://register.cacbg.bg/2024/i.xml'),
  ('decl:g','person:ГЕОРГИ ПЕТРОВ','g.xml','H2','2024','2023','assets','','МИНИСТЕРСТВО Х','', 'https://register.cacbg.bg/2024/g.xml'),
  ('decl:d','person:ДАНА ФАМ','d.xml','H3','2024','2023','assets','','ОБЩИНА ВАРНА','', 'https://register.cacbg.bg/2024/d.xml'),
  ('decl:b','person:БОРИС БОРД','b.xml','H4','2024','2023','assets','','АГЕНЦИЯ У','', 'https://register.cacbg.bg/2024/b.xml');
INSERT INTO interest_links
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
  ('il:ia','person:ИВАН МИНЕВ|111','person:ИВАН МИНЕВ','eik:111','111111111','АЛФА ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2023',1,1000000,'2021','2021','published'),
  ('il:ig','person:ИВАН МИНЕВ|333','person:ИВАН МИНЕВ','eik:333','333333333','ГАМА ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2023',1,200000,'2021','2021','published'),
  ('il:gb','person:ГЕОРГИ ПЕТРОВ|222','person:ГЕОРГИ ПЕТРОВ','eik:222','222222222','БЕТА ООД','exact_name_key','v1','C_hold','owns','private_ownership',0,'none',1,'2020','2020',1,500000,'2021','2021','held'),
  -- family_ownership, published → under ADR-0032 it reaches the index identically to self: Дана IS searchable,
  -- ДЕЛТА IS flagged. The relative is never named (relation 'related'); the office-holder Дана is the row.
  ('il:df','person:ДАНА ФАМ|444','person:ДАНА ФАМ','eik:444','444444444','ДЕЛТА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2023',1,300000,'2021','2021','published'),
  -- management_role, marked published (a hypothetical mis-status) → the interest_class gate must STILL exclude
  -- it: a statutory board/management role is never a declared conflict, so it can never reach search or a badge.
  ('il:bm','person:БОРИС БОРД|555','person:БОРИС БОРД','eik:555','555555555','ЕПСИЛОН ООД','exact_name_key','v1','B_distinctive','manages','management_role',0,'none',1,'2020','2023',1,700000,'2021','2021','published'),
  -- Двоен declared BOTH his own and a relative's stake in ЗЕТА (eik 666). The self stake already names him,
  -- so the redundant-family collapse (ADR-0032) DROPS the family link from the index; the winner's €50k counts
  -- ONCE, not €100k — no de-anonymization vector, no double-count.
  ('il:ds','person:ДВОЕН ТЕСТ|666','person:ДВОЕН ТЕСТ','eik:666','666666666','ЗЕТА ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2023',1,50000,'2021','2021','published'),
  ('il:dfam','person:ДВОЕН ТЕСТ|666|family','person:ДВОЕН ТЕСТ','eik:666','666666666','ЗЕТА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2023',1,50000,'2021','2021','published'),
  -- published, ownership class, live contracts — and NO seal. Everything the badge used to check, passed.
  ('il:no','person:БЕЗ ПЕЧАТ|777','person:БЕЗ ПЕЧАТ','eik:777','777777777','ЙОТА ООД','exact_name_key','v1','document','owns','private_ownership',0,'none',1,'2020','2023',1,400000,'2021','2021','published'),
  -- published, and sealed with a rung that WITHHOLDS (ADR-0035). A seal existing is not a seal permitting.
  ('il:un','person:ЗАДЪРЖАН ПЕЧАТ|888','person:ЗАДЪРЖАН ПЕЧАТ','eik:888','888888888','КАПА ООД','exact_name_key','v1','document_uncorroborated','owns','private_ownership',0,'none',1,'2020','2023',1,600000,'2021','2021','published');
INSERT INTO interest_link_evidence (link_key, evidence_kind, lookup_date, rules_version, live_status) VALUES
  ('person:ИВАН МИНЕВ|111','document','2026-08-12','tr-rules-1','live'),
  ('person:ИВАН МИНЕВ|333','confirmed','2026-08-12','tr-rules-1','live'),
  ('person:ДАНА ФАМ|444','confirmed','2026-08-12','tr-rules-1','live'),
  ('person:БОРИС БОРД|555','document','2026-08-12','tr-rules-1','live'),
  ('person:ДВОЕН ТЕСТ|666','document','2026-08-12','tr-rules-1','live'),
  ('person:ДВОЕН ТЕСТ|666|family','document','2026-08-12','tr-rules-1','live'),
  ('person:ЗАДЪРЖАН ПЕЧАТ|888','document_uncorroborated','2026-08-12','tr-rules-1','live');
INSERT INTO authorities (id, name) VALUES ('a:1','ВЕДОМСТВО ТЕСТ');
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES
  ('t:1','s1','Т1','a:1','open'),('t:3','s3','Т3','a:1','open'),('t:4','s4','Т4','a:1','open'),
  ('t:6','s6','Т6','a:1','open'),('t:7','s7','Т7','a:1','open'),('t:8','s8','Т8','a:1','open');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c:1','t:1','eik:111',1000000,'EUR','2021-05-01','N1',1000000),
  ('c:3','t:3','eik:333',200000,'EUR','2021-05-01','N3',200000),
  ('c:4','t:4','eik:444',300000,'EUR','2021-05-01','N4',300000),
  ('c:6','t:6','eik:666',50000,'EUR','2021-05-01','N6',50000),
  ('c:7','t:7','eik:777',400000,'EUR','2021-05-01','N7',400000),
  ('c:8','t:8','eik:888',600000,'EUR','2021-05-01','N8',600000);
`;

// Search-index population — a STRUCTURAL proxy for scripts/precompute.sql's officials block: it exercises the
// publish + ownership (self OR family, ADR-0032) filter, the redundant-family collapse, and the per-person
// GROUP BY — the parts this suite asserts. The `amount` here is the pre-summed il.contract_value_eur, NOT
// production's contemporaneous windowed subquery (which needs a contracts/tenders/authorities fixture); that
// per-link contemporaneous formula is exercised on the read side by related-persons-sql.test.ts (LINK_SELECT),
// and the "precompute ≡ refresh-slice" invariant is enforced by the drift-guard test below — so a divergence
// in the real €-formula fails a test rather than silently overstating the public figure.
const POPULATE_INDEX = `
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'company', ct.bidder_id, ct.name, COALESCE(ct.eik, ''), COALESCE(ct.settlement, ''), ct.won_eur
FROM company_totals ct;
INSERT INTO search_index (kind, ref, title, ident, subtitle, amount)
SELECT 'official', il.person_id, p.name, NULL,
  (SELECT d.institution FROM declarations d WHERE d.person_id = il.person_id
   ORDER BY d.declared_year DESC LIMIT 1),
  SUM(il.contract_value_eur)
FROM interest_links il JOIN persons p ON p.id = il.person_id
WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
  AND NOT (il.interest_class = 'family_ownership' AND EXISTS (
    SELECT 1 FROM interest_links s WHERE s.person_id = il.person_id AND s.eik = il.eik
      AND s.status = 'published' AND s.interest_class = 'private_ownership'))
GROUP BY il.person_id, p.name;
`;

function withDb(fn: (dbPath: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), 'search-sql-'));
  const dbPath = resolve(dir, 'test.db');
  try {
    readScript(dbPath, migration0);
    readScript(dbPath, migration2);
    readScript(dbPath, migration9);
    exec(dbPath, FIXTURE);
    exec(dbPath, POPULATE_INDEX);
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('search свързани-лица SQL', () => {
  it('indexes one official row per person (dedupes multiple links), PUBLISHED only', () => {
    withDb((dbPath) => {
      // Иван has two published links (АЛФА + ГАМА) → ONE official row, amount = their sum. Георги's only
      // link is 'held' → not indexed at all (the surface never published him).
      const officials = rows(dbPath, lit(SEARCH_HITS_SQL, 'official', 'иван*', 10));
      expect(officials).toHaveLength(1);
      expect(officials[0]!.ref).toBe('person:ИВАН МИНЕВ');
      expect(officials[0]!.title).toBe('Иван Минев');
      expect(officials[0]!.subtitle).toBe('ОБЩИНА РУСЕ'); // latest institution disambiguates homonyms
      expect(officials[0]!.amount).toBe(1200000); // 1_000_000 + 200_000
      expect(rows(dbPath, lit(SEARCH_HITS_SQL, 'official', 'георги*', 10))).toHaveLength(0);
    });
  });

  it('flags a company with a PUBLISHED link and not one without (badge join keys on ЕИК)', () => {
    withDb((dbPath) => {
      const alfa = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'алфа*', 10));
      expect(alfa).toHaveLength(1);
      expect(alfa[0]!.has_conflict).toBe(1); // АЛФА is Иван's declared stake
      // БЕТА's only link is 'held' → the published-only join must NOT flag it.
      const beta = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'бета*', 10));
      expect(beta).toHaveLength(1);
      expect(beta[0]!.has_conflict).toBe(0);
    });
  });

  it('the badge requires an evidence SEAL, not merely status=published (#279)', () => {
    // The detail page gate is belt-and-braces — status AND a publishing seal (SURFACED_OWNERSHIP). The
    // badge checked status alone, so an evidence-less published row advertised a свързани-лица claim on a
    // named official in search while the page it links to correctly withheld it. Search is the wider
    // surface of the two: it is what a reader sees before deciding to look.
    withDb((dbPath) => {
      // NO seal at all — the legacy/partial-run/loader-bug shape.
      const iota = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'йота*', 10));
      expect(iota).toHaveLength(1);
      expect(iota[0]!.has_conflict).toBe(0);
      // Sealed, but with a rung that WITHHOLDS. A seal existing is not a seal permitting.
      const kapa = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'капа*', 10));
      expect(kapa).toHaveLength(1);
      expect(kapa[0]!.has_conflict).toBe(0);
      // POSITIVE CONTROL — a properly sealed link still badges, on both publishing rungs. Without this a
      // gate that rejected everything would satisfy the two assertions above.
      expect(rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'алфа*', 10))[0]!.has_conflict).toBe(1);
      expect(rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'гама*', 10))[0]!.has_conflict).toBe(1);
    });
  });

  it('indexes family_ownership (ADR-0032) but NEVER management_role/ex-officio (interest_class gate)', () => {
    withDb((dbPath) => {
      // family_ownership now reaches the index identically to self (ADR-0032): Дана (a relative's stake) IS
      // searchable by her own name, and ДЕЛТА IS flagged — the /conflicts page already publishes that link, so
      // the badge discloses nothing the surface doesn't. The relative is never named.
      expect(rows(dbPath, lit(SEARCH_HITS_SQL, 'official', 'дана*', 10))).toHaveLength(1);
      const delta = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'делта*', 10));
      expect(delta).toHaveLength(1);
      expect(delta[0]!.has_conflict).toBe(1);

      // management_role marked published → the interest_class gate must still exclude it, both from the
      // officials index (no name in search) and from the company badge join. A statutory board/management
      // role is never surfaced as a "conflict" — the libel-critical distinction that ADR-0032 does NOT relax.
      expect(rows(dbPath, lit(SEARCH_HITS_SQL, 'official', 'борис*', 10))).toHaveLength(0);
      const epsilon = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'епсилон*', 10));
      expect(epsilon).toHaveLength(1);
      expect(epsilon[0]!.has_conflict).toBe(0);
    });
  });

  it('the no-conflict hits variant ignores interest_links (un-migrated-env fallback)', () => {
    // search() falls back to this variant when the свързани-лица migration (0003) is absent. It must not
    // reference interest_links at all (so a missing table can never 500 the search) and reports
    // has_conflict=0 for every company — even АЛФА, which has a real published own-stake conflict.
    expect(SEARCH_HITS_SQL_NO_CONFLICT).not.toContain('interest_links');
    withDb((dbPath) => {
      const alfa = rows(dbPath, lit(SEARCH_HITS_SQL_NO_CONFLICT, 'company', 'алфа*', 10));
      expect(alfa).toHaveLength(1);
      expect(alfa[0]!.has_conflict).toBe(0);
    });
  });

  it('runs SEARCH_HITS_SQL for every kind without error and returns the FTS rank', () => {
    withDb((dbPath) => {
      // The query is shared across kinds — a rank/join slip would break company/contract search too. Prove
      // it executes and yields a numeric rank (the value the relevance gate reads).
      const hit = rows(dbPath, lit(SEARCH_HITS_SQL, 'company', 'гама*', 10));
      expect(hit).toHaveLength(1);
      expect(typeof hit[0]!.rank).toBe('number');
      expect(hit[0]!.has_conflict).toBe(1); // ГАМА is Иван's second stake
    });
  });

  it('counts a winner ONCE for an official who declared both their own and a relative’s stake in it', () => {
    withDb((dbPath) => {
      // Двоен has a self AND a family link to ЗЕТА (eik 666), €50k each. The self stake names him, so the
      // redundant-family collapse (ADR-0032) drops the family link — „по договори" is €50k, not the €100k a
      // naive per-link SUM would report. One official row still (the two links share the person).
      const dvoen = rows(dbPath, lit(SEARCH_HITS_SQL, 'official', 'двоен*', 10));
      expect(dvoen).toHaveLength(1);
      expect(dvoen[0]!.ref).toBe('person:ДВОЕН ТЕСТ');
      expect(dvoen[0]!.amount).toBe(50000); // NOT 100000 — the redundant family link collapsed, winner's € counts once
    });
  });

  // The officials €-figure is libel-critical: it must be defined identically on both ETL paths (the full
  // precompute and the incremental refresh-slice), else a refresh silently changes the published number.
  // Enforce it — extract each file's `SELECT 'official' … GROUP BY il.person_id, p.name;` block and require
  // byte-equality. This is the machine-checked form of the "identical signed_at/amount_eur semantics"
  // review ask; drift in either file (a changed window, a dropped filter) now fails here.
  it('officials search-index block is byte-identical between precompute.sql and refresh-slice.sql', () => {
    const officialsBlock = (file: string): string => {
      const sql = readFileSync(resolve(root, file), 'utf8');
      const start = sql.indexOf("SELECT 'official'");
      // The block closes on the officials GROUP BY (ADR-0032).
      const end = sql.indexOf('GROUP BY il.person_id, p.name;', start);
      expect(start, `no officials SELECT in ${file}`).toBeGreaterThanOrEqual(0);
      expect(end, `no officials GROUP BY in ${file}`).toBeGreaterThanOrEqual(0);
      return sql.slice(start, end + 'GROUP BY il.person_id, p.name;'.length);
    };
    // SQL whitespace is insignificant (the two files format the subtitle subquery differently) — compare
    // on collapsed whitespace so only a SEMANTIC divergence (a changed window, filter, or amount column) fails.
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const pc = officialsBlock('scripts/precompute.sql');
    const rs = officialsBlock('scripts/refresh-slice.sql');
    // Sanity: the block really is the contemporaneous windowed sum, not a lifetime column.
    expect(pc).toContain('BETWEEN CAST(il.first_declared_year AS INTEGER)');
    expect(pc).not.toContain('SUM(il.contract_value_eur)');
    expect(norm(rs)).toBe(norm(pc));
  });
});
