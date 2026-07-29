/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_SQL,
  LEADERBOARD_SQL,
  LINK_CONTRACTS_SQL,
  OFFICIAL_SQL,
  WITHHELD_FAMILY_AGGREGATE_SQL,
} from './queries/related-persons';

// Integration test for the свързани-лица SQL. The query layer's unit tests (queries/related-persons.test)
// use a fake D1 and never run the aggregation; this runs the EXACT exported SQL against a real SQLite
// built from the production migrations (0000 + 0002) with a deterministic fixture, asserting the private
// vs ex-officio separation (ADR-0019), the value ordering, and the source_url provenance subquery.
// Mirrors the sqlite3-CLI harness of competition-sql.test.ts (no better-sqlite3 dependency).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2 = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' }).trim();
}
function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}
// Substitute D1 `?` binds with SQL literals so the exported query runs through the sqlite3 CLI unchanged.
function lit(sql: string, ...vals: (string | number)[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = vals[i++];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
}
// Rows as objects keyed by column name — JSON output, since link_key itself contains a '|' that would
// break a pipe-split of the default list mode.
function rows(dbPath: string, sql: string): Record<string, string | number | null>[] {
  const out = execFileSync('sqlite3', ['-json', dbPath], { input: sql, encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

// Иван OWNS ТРЕЙС (private_ownership, own institution, €88M). Борис + Виктор both MANAGE ХОЛДИНГ 9
// (declared by two officials → ex_officio_board, €5M each). Кмет declares a CLOSE RELATIVE's stake in
// ЕВРОСТРОЙ (family_ownership, €250k) — WITHHELD from the named surface (status 'internal'), counted only in
// the nameless aggregate. Голям owns ГОЛЯМ (private, €50M, NO nexus) — a high-value link with no
// own-institution tie, to prove NEXUS-first ordering beats raw value. Only Иван has a declaration row → his
// link resolves a source_url; the others do not (NULL).
const FIXTURE = `
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:111','ТРЕЙС ГРУП ХОЛД АД','111','111',1,'company'),
  ('eik:222','ХОЛДИНГ 9 ЕАД','222','222',1,'company'),
  ('eik:333','ЕВРОСТРОЙ 21 ЕООД','333','333',1,'company'),
  ('eik:444','ГОЛЯМ ООД','444','444',1,'company'),
  ('eik:555','П2АРХ ООД','555','555',1,'company');
INSERT INTO persons (id, name) VALUES
  ('person:ivan','Иван Минев'),('person:boris','Борис Манолов'),('person:viktor','Виктор Асенов'),
  ('person:kmet','Кмет Тестов'),('person:big','Голям Официал'),('person:dual','Двоен Тестов');
INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
  ('decl:i','person:ivan','i.xml','H1','2024','2023','assets','','ТЕСТ','', 'https://register.cacbg.bg/2024/i.xml');
INSERT INTO declared_interests (id, declaration_id, entity_raw, entity_key, kind, detail, timing, seat) VALUES
  ('di:i','decl:i','ТРЕЙС ГРУП ХОЛД АД','ТРЕЙС ГРУП ХОЛД АД','shares','','annual','');
INSERT INTO interest_links
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
  ('il:ivan','person:ivan|111','person:ivan','eik:111','111','ТРЕЙС ГРУП ХОЛД АД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'exact',1,'2019','2023',35,88000000,'2021','2024','published'),
  ('il:boris','person:boris|222','person:boris','eik:222','222','ХОЛДИНГ 9 ЕАД','exact_name_key','v1','B_distinctive','manages','ex_officio_board',0,'none',1,'2023','2023',10,5000000,'2023','2023','published'),
  ('il:viktor','person:viktor|222','person:viktor','eik:222','222','ХОЛДИНГ 9 ЕАД','exact_name_key','v1','B_distinctive','manages','ex_officio_board',0,'none',1,'2023','2023',10,5000000,'2023','2023','published'),
  -- family_ownership is withheld from the named surface (ADR-0030): load.mjs marks it 'internal' (passed
  -- every gate, but held back by the family policy). It never surfaces on any named view; it is counted only
  -- in the nameless aggregate. Кмет's standalone relative stake (€250k) is the aggregate's one member here.
  ('il:fam','person:kmet|333|family','person:kmet','eik:333','333','ЕВРОСТРОЙ 21 ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',1,'exact',1,'2018','2020',5,250000,'2019','2020','internal'),
  ('il:big','person:big|444','person:big','eik:444','444','ГОЛЯМ ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2021',10,50000000,'2020','2021','published'),
  -- Двоен declared BOTH his OWN stake and a RELATIVE's stake in П2АРХ (eik 555): two published links, same
  -- winner, same €79k. The surface must collapse them to the own-stake row — else €79k is counted twice and
  -- Двоен appears twice for one company (de-anon). own_inst='none'/contemp=0 → ranks after Голям.
  ('il:dual-self','person:dual|555','person:dual','eik:555','555','П2АРХ ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2022',4,79000,'2021','2022','published'),
  ('il:dual-fam','person:dual|555|family','person:dual','eik:555','555','П2АРХ ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2022',4,79000,'2021','2022','internal'),
  -- a HELD link must never surface in any query
  ('il:held','person:ivan|999','person:ivan','eik:111','999','НЯКОЙ ООД','exact_name_key','v1','C_hold','owns','private_ownership',0,'none',1,'2022','2022',3,1000,'2022','2022','held'),
  -- a WITHDRAWN (divested — later filing omits the company) link must never surface either (§8/E11)
  ('il:gone','person:viktor|111','person:viktor','eik:111','111','ТРЕЙС ГРУП ХОЛД АД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2015','2015',5,2000000,'2016','2016','withdrawn');
-- Contracts for Иван's winner (eik 111), against his declared span 2019–2023: c:1 (2020) and c:2 (2023)
-- fall IN the window, c:3 (2024) AFTER it, c:4 (undated) UNKNOWN. This makes the read-time split
-- deterministic: contemporaneous = 2 contracts / €30M; the total contract_value_eur column is unrelated
-- (stored €88M) — the point is the read-time window subset, not the stored aggregate.
INSERT INTO authorities (id, name) VALUES ('a:1','ОБЩИНА ТЕСТ');
-- t:2 is a DIRECT AWARD (no public notice) — the read query surfaces the procedure verbatim per tender, so
-- this must ride through as-is; t:4 is a synthetic tender ('неизвестна') that the mapping folds to null.
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES
  ('t:1','unp1','Ремонт на път','a:1','открита процедура'),
  ('t:2','unp2','Доставка на софтуер','a:1','договаряне без обявление'),
  ('t:3','unp3','Т3','a:1','открита процедура'),('t:4','unp4','Т4','a:1','неизвестна');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c:1','t:1','eik:111',10000000,'EUR','2020-05-01','Д-1',10000000),
  ('c:2','t:2','eik:111',20000000,'EUR','2023-07-01','Д-2',20000000),
  ('c:3','t:3','eik:111',5000000,'EUR','2024-02-01','Д-3',5000000),
  ('c:4','t:4','eik:111',1000000,'EUR',NULL,'Д-4',1000000);
-- Rollup row for the awarding body — the per-authority capture-share denominator the read query LEFT JOINs.
INSERT INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur) VALUES
  ('a:1','ОБЩИНА ТЕСТ',50000000,10,4,5000000);
`;

describe('свързани-лица SQL (real SQLite)', () => {
  function withDb<T>(fn: (dbPath: string) => T): T {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-related-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      readScript(dbPath, migration2);
      sqlite(dbPath, FIXTURE);
      return fn(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('leaderboard returns the official’s OWN ownership only (private), NEXUS-ranked; family/held/withdrawn/ex-officio excluded', () => {
    withDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      // Excluded: held €1000, withdrawn €2M, both ex-officio board links, Кмет's family stake (withheld —
      // ADR-0030), and Двоен's family link. Three SELF nexuses remain (Двоен's own stake stays; his family
      // one does not surface).
      expect(board.map((r) => r.official)).toEqual(['Иван Минев', 'Голям Официал', 'Двоен Тестов']);
      // A close relative's stake is NEVER named on the surface — Кмет (family only) must be absent entirely,
      // and no surfaced row may carry relation='related'.
      expect(board.some((r) => r.official === 'Кмет Тестов')).toBe(false);
      expect(board.every((r) => r.relation !== 'related')).toBe(true);
      // NEXUS-first: Иван (own institution) leads; Голям (€50M, no nexus but contemporaneous) outranks Двоен.
      expect(board[0]!.official).toBe('Иван Минев');
      expect(board[1]!.official).toBe('Голям Официал');
      expect(board[0]!.contract_value_eur).toBe(88_000_000);
      expect(board[0]!.first_declared_year).toBe('2019');
      expect(board[0]!.last_declared_year).toBe('2023');
      expect(board[0]!.source_url).toBe('https://register.cacbg.bg/2024/i.xml');
      // institution carries through from the latest declaration — the namesake disambiguator (I7).
      expect(board[0]!.institution).toBe('ТЕСТ');
    });
  });

  it('a family_ownership link never surfaces on the leaderboard — even when its declaration resolves (de-anon, libel)', () => {
    withDb((dbPath) => {
      // ADR-0030: a close relative's stake is withheld from the named surface entirely (not merely
      // source-nulled). Give Кмет's family link a real declaration that WOULD resolve a source_url — the row
      // must still be absent from the board, so nothing (name, company, ЕИК, source) about the relative ships.
      sqlite(
        dbPath,
        `INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
           ('decl:k','person:kmet','k.xml','H2','2021','2020','assets','','ОБЩИНА','', 'https://register.cacbg.bg/2021/k.xml');
         INSERT INTO declared_interests (id, declaration_id, entity_raw, entity_key, kind, detail, timing, seat) VALUES
           ('di:k','decl:k','ЕВРОСТРОЙ 21 ЕООД','ЕВРОСТРОЙ 21 ЕООД','shares','','annual','');`,
      );
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.find((r) => r.official === 'Кмет Тестов')).toBeUndefined(); // family link withheld
      const ivan = board.find((r) => r.official === 'Иван Минев');
      expect(ivan!.source_url).toBe('https://register.cacbg.bg/2024/i.xml'); // self link keeps provenance
    });
  });

  it('the nameless family aggregate counts withheld close-relative stakes, excluding those redundant with a self stake', () => {
    withDb((dbPath) => {
      // ADR-0030: family stakes are reported only as counts. Кмет's standalone relative stake in ЕВРОСТРОЙ
      // (€250k, status 'internal') is the one member. Двоен's family stake is EXCLUDED — he holds a published
      // OWN stake in the same winner (already on the board + counted), so counting it would inflate the €.
      const agg = rows(dbPath, WITHHELD_FAMILY_AGGREGATE_SQL)[0]!;
      expect(Number(agg.official_count)).toBe(1);
      expect(Number(agg.link_count)).toBe(1);
      expect(Number(agg.total_eur)).toBe(250000);
    });
  });

  it('ranks by the CONTEMPORANEOUS conflict-window value, not the lifetime total, when the nexus tier ties', () => {
    withDb((dbPath) => {
      // Two officials in the SAME nexus tier (own_institution='none', contemporaneous=1) whose lifetime and
      // in-window values DISAGREE on order. Ален: small €1M lifetime but €900k signed inside his window.
      // Боян: large €10M lifetime but only €100k in-window (the rest signed after he divested). The headline
      // number the card shows is the €900k / €100k contemporaneous figure — so the ranking must put Ален
      // above Боян. The old `contract_value_eur DESC` tiebreak ranked by lifetime and put Боян (€10M) first,
      // contradicting the number on his own card. This pins that the sort key matches the displayed value.
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
           ('eik:701','АЛЕН КО ООД','701','701',1,'company'),('eik:702','БОЯН КО ООД','702','702',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:alen','Ален Тестов'),('person:boyan','Боян Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:alen','person:alen|701','person:alen','eik:701','701','АЛЕН КО ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2021',1,1000000,'2021','2021','published'),
           ('il:boyan','person:boyan|702','person:boyan','eik:702','702','БОЯН КО ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2021',1,10000000,'2021','2021','published');
         INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES
           ('t:71','unp71','Обект А','a:1','открита процедура'),('t:72','unp72','Обект Б','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
           ('c:71','t:71','eik:701',900000,'EUR','2021-05-01','Д-71',900000),
           ('c:72','t:72','eik:702',100000,'EUR','2021-05-01','Д-72',100000);`,
      );
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      const order = board
        .map((r) => r.official)
        .filter((o) => o === 'Ален Тестов' || o === 'Боян Тестов');
      // Ален (€900k in-window) outranks Боян (€100k in-window) despite Боян's 10× larger lifetime total.
      expect(order).toEqual(['Ален Тестов', 'Боян Тестов']);
    });
  });

  it('a family (close-relative) link never surfaces on the winner or official view (withheld — ADR-0030)', () => {
    withDb((dbPath) => {
      // ЕВРОСТРОЙ (eik 333) carries ONLY Кмет's family stake → the company view is empty (no named row for
      // the relative's company). Кмет, who declared only a relative's stake, has no official page at all —
      // the surface never names a person on account of a family stake.
      expect(rows(dbPath, lit(COMPANY_SQL, '333'))).toHaveLength(0);
      expect(rows(dbPath, lit(OFFICIAL_SQL, 'person:kmet'))).toHaveLength(0);
    });
  });

  it('ex-officio / management roles are never surfaced — not even on the winner’s own page', () => {
    withDb((dbPath) => {
      // ЕИК 222 has only ex-officio board links (Борис + Виктор) → the company view is empty, not a list of them
      const board = rows(dbPath, lit(COMPANY_SQL, '222'));
      expect(board).toHaveLength(0);
    });
  });

  it('official view returns one office-holder’s ownership links; withdrawn links excluded on the winner view', () => {
    withDb((dbPath) => {
      const ivan = rows(dbPath, lit(OFFICIAL_SQL, 'person:ivan'));
      expect(ivan).toHaveLength(1); // published private only — the held link is excluded
      expect(ivan[0]!.company).toBe('ТРЕЙС ГРУП ХОЛД АД');

      // ЕИК 111: only Иван (published) — Виктор's withdrawn (divested) link to the same winner is excluded
      const trace = rows(dbPath, lit(COMPANY_SQL, '111'));
      expect(trace.map((r) => r.official)).toEqual(['Иван Минев']);
    });
  });

  it('shows the official’s own stake once when they declared both their own and a relative’s stake in the same winner (family withheld — no €-double-count, no de-anon)', () => {
    withDb((dbPath) => {
      // Двоен has an own stake (private_ownership) AND a relative's stake (family_ownership, withheld) in
      // П2АРХ. Only the own-stake row surfaces, so €79k is counted once and Двоен is not shown twice for one
      // company (the ТР-cross-reference de-anon vector is closed by construction — family never surfaces).
      const company = rows(dbPath, lit(COMPANY_SQL, '555'));
      expect(company).toHaveLength(1);
      expect(company[0]!.relation).toBe('owns');
      const official = rows(dbPath, lit(OFFICIAL_SQL, 'person:dual'));
      expect(official).toHaveLength(1);
      expect(official[0]!.relation).toBe('owns');
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.filter((r) => r.official === 'Двоен Тестов')).toHaveLength(1);
    });
  });

  it('an ЕИК carried by >1 bidder row sums that ЕИК’s in-window contracts ONCE per (official,ЕИК) — no €-inflation (libel)', () => {
    withDb((dbPath) => {
      // ydimitrof #226 (related-persons.ts:87): the contemporaneous subquery joins on eik_normalized = il.eik,
      // so if an ЕИК is carried by MORE THAN ONE bidder row it sums the company’s in-window contracts across
      // BOTH rows — the correct company total — while the outer projection still returns exactly ONE row for
      // (official, ЕИК). A regression that multiplied per bidder row would double this libel-sensitive €.
      // A SECOND bidder record carries the SAME eik_normalized '111'; Иван’s window 2019–2023 captures
      // c:1(€10M,2020) + c:2(€20M,2023) on the original row and c:1b(€4M,2021) on the duplicate = €34M / 3.
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
           ('eik:111b','ТРЕЙС ГРУП ХОЛД АД (дубликат)',NULL,'111',1,'company');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
           ('c:1b','t:1','eik:111b',4000000,'EUR','2021-06-01','Д-1Б',4000000);`,
      );
      const trace = rows(dbPath, lit(OFFICIAL_SQL, 'person:ivan')).filter((r) => r.eik === '111');
      expect(trace).toHaveLength(1); // exactly one (Иван, 111) row — not one per bidder record
      expect(Number(trace[0]!.contemporaneous_value_eur)).toBe(34000000);
      expect(Number(trace[0]!.contemporaneous_contract_count)).toBe(3);
    });
  });

  it('a family link never surfaces even if it carried status=published or resolved to a DIFFERENT bidder row (read-layer class gate)', () => {
    withDb((dbPath) => {
      // Defense-in-depth: the read query filters interest_class='private_ownership' — an INDEPENDENT gate from
      // load.mjs's status. Even a family row that (wrongly) carried status='published' and resolved to a variant
      // bidder row for the same ЕИК must stay hidden. ONE eik ('800') on TWO bidder rows: Дубъл's own stake →
      // 'eik:800', his relative's stake → 'eik:800b' (same company, different bidder_id, status 'published').
      // The own stake surfaces; the family one never does — no де-анон via a bidder-row split (ADR-0030).
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
           ('eik:800','ДУБЪЛ ЕООД','800','800',1,'company'),
           ('eik:800b','ДУБЪЛ ЕООД (вариант на име)',NULL,'800',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:dubl','Дубъл Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:dubl-self','person:dubl|800','person:dubl','eik:800','800','ДУБЪЛ ЕООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2022',2,60000,'2021','2022','published'),
           ('il:dubl-fam','person:dubl|800|family','person:dubl','eik:800b','800','ДУБЪЛ ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2022',2,60000,'2021','2022','published');`,
      );
      // COMPANY view for eik 800: both links match il.eik='800'; the family one must collapse → one 'owns' row.
      const company = rows(dbPath, lit(COMPANY_SQL, '800'));
      expect(company).toHaveLength(1);
      expect(company[0]!.relation).toBe('owns');
      // …and the official view collapses too — Дубъл is never shown twice for the one company (no de-anon).
      const official = rows(dbPath, lit(OFFICIAL_SQL, 'person:dubl'));
      expect(official).toHaveLength(1);
      expect(official[0]!.relation).toBe('owns');
    });
  });

  it('splits contracts into the contemporaneous (in-declared-window) subset — read-time, no stored column', () => {
    withDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      const ivan = board.find((r) => r.official === 'Иван Минев')!;
      // Иван declared 2019–2023: c:1 (2020) + c:2 (2023) are in-window; c:3 (2024) after, c:4 undated.
      expect(ivan.contemporaneous_contract_count).toBe(2);
      expect(ivan.contemporaneous_value_eur).toBe(30_000_000);
      // the split is a SUBSET of the stored total, never exceeds it
      expect(Number(ivan.contemporaneous_value_eur)).toBeLessThanOrEqual(
        Number(ivan.contract_value_eur),
      );
      // a link with no contracts in the window reports 0 / NULL, not a fabricated figure
      const golyam = board.find((r) => r.official === 'Голям Официал')!;
      expect(golyam.contemporaneous_contract_count).toBe(0);
      expect(golyam.contemporaneous_value_eur).toBeNull();
    });
  });

  it('per-contract list marks each contract in/out the window, contemporaneous-first', () => {
    withDb((dbPath) => {
      const list = rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:ivan|111'));
      expect(list).toHaveLength(4);
      // contemporaneous first (by signed_at DESC), then the rest
      expect(list.map((r) => [r.contract_number, r.temporal])).toEqual([
        ['Д-2', 'contemporaneous'], // 2023
        ['Д-1', 'contemporaneous'], // 2020
        ['Д-3', 'after'], // 2024
        ['Д-4', 'unknown'], // undated
      ]);
      // the contract id rides along in the same order → the UI links each row to /contracts/:id
      expect(list.map((r) => r.id)).toEqual(['c:2', 'c:1', 'c:3', 'c:4']);
      // award procedure + subject ride through verbatim, per tender (proves it's not a hardcoded column):
      // Д-2/t:2 is the direct award, Д-1/t:1 the open one, and the synthetic 'неизвестна' folds to NULL.
      const byNum = Object.fromEntries(list.map((r) => [r.contract_number, r]));
      expect(byNum['Д-2'].procedure_type).toBe('договаряне без обявление');
      expect(byNum['Д-1'].procedure_type).toBe('открита процедура');
      expect(byNum['Д-4'].procedure_type).toBeNull(); // NULLIF folds the synthetic-tender sentinel
      expect(byNum['Д-2'].subject).toBe('Доставка на софтуер');
      // Per-authority capture join: every row carries its body id + the body's rollup total (the share's
      // denominator). Same authority here → same id + total across all four rows.
      expect(list.map((r) => r.authority_id)).toEqual(['a:1', 'a:1', 'a:1', 'a:1']);
      expect(list.every((r) => Number(r.authority_total_eur) === 50000000)).toBe(true);
      // INVARIANT: the in-window amounts here sum to EXACTLY the leaderboard's contemporaneous_value_eur —
      // the list and the split cannot disagree (same join, same window bounds). This is the libel proof.
      const inWindow = list.filter((r) => r.temporal === 'contemporaneous');
      const inWindowSum = inWindow.reduce((s, r) => s + Number(r.amount_eur), 0);
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      const ivan = board.find((r) => r.official === 'Иван Минев')!;
      expect(inWindowSum).toBe(Number(ivan.contemporaneous_value_eur));
      // …and its COUNT twin: the leaderboard's contemporaneous_contract_count (the „X" in „X от Y" on the
      // card) must equal the in-window rows the list expands to. Both are computed live from the same join,
      // so a drift here = the collapsed card contradicting its own detail — decoupled from fixture literals
      // above, this ties the two query paths directly and fails on any predicate skew between them.
      expect(inWindow).toHaveLength(Number(ivan.contemporaneous_contract_count));
    });
  });

  it('LEFT JOINs the authority rollup — a body with no total still returns its contracts (null total, no drop)', () => {
    withDb((dbPath) => {
      // Drop the rollup so a:1 has no total row. An INNER JOIN here would silently vanish every contract
      // (data loss → undercount); the LEFT JOIN must keep all four with a null denominator instead.
      sqlite(dbPath, `DELETE FROM authority_totals;`);
      const list = rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:ivan|111'));
      expect(list).toHaveLength(4);
      expect(list.every((r) => r.authority_total_eur === null)).toBe(true);
    });
  });

  it('the contract list never leaks a non-surfaced link (held / withdrawn / unknown key → empty)', () => {
    withDb((dbPath) => {
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:ivan|999'))).toHaveLength(0); // held
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:viktor|111'))).toHaveLength(0); // withdrawn
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:nobody|000'))).toHaveLength(0); // unknown
    });
  });

  it('the /contracts route never serves a family link_key (family surface withheld — de-anon oracle closed)', () => {
    withDb((dbPath) => {
      // Двоен's family link to П2АРХ (eik 555) is withheld from every surface (ADR-0030 — family is internal).
      // Give eik 555 a real contract so the ONLY reason the family key returns [] is the class gate, not an
      // empty contract set. A leak here would be an existence-oracle confirming the relative's stake.
      sqlite(
        dbPath,
        `INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:9','unp9','П2АРХ строеж','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES ('c:9','t:9','eik:555',79000,'EUR','2021-05-01','Д-9',79000);`,
      );
      // The surfaced self link returns its contract…
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:dual|555'))).toHaveLength(1);
      // …but the collapsed family link_key returns [] — no probe for the suppressed relative stake.
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:dual|555|family'))).toHaveLength(0);
    });
  });

  it('a STANDALONE family link is also withheld from /contracts — the whole family surface is internal (ADR-0030)', () => {
    withDb((dbPath) => {
      // Кмет declared only a RELATIVE's stake in ЕВРОСТРОЙ (eik 333) — no own stake. Under ADR-0030 the family
      // surface is withdrawn entirely, so even a standalone relative-ownership conflict has no drill-down; it
      // is represented only by the nameless aggregate. Give eik 333 a real contract so [] is the class gate,
      // not an empty contract set — proving no family drill-down survives.
      sqlite(
        dbPath,
        `INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:8','unp8','Обект','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES ('c:8','t:8','eik:333',250000,'EUR','2019-05-01','Д-8',250000);`,
      );
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:kmet|333|family'))).toHaveLength(0);
    });
  });
});
