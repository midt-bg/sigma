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
  LINK_CONTRACTS_LIMIT,
  LINK_CONTRACTS_SQL,
  OFFICIAL_SQL,
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
// ЕВРОСТРОЙ (family_ownership, €250k) — under ADR-0032 this PUBLISHES on the named surface identically to a
// self stake (relation 'related'), with the relative never named. Голям owns ГОЛЯМ (private, €50M, NO nexus)
// — a high-value link with no own-institution tie, to prove NEXUS-first ordering beats raw value. Иван and
// Кмет each have a declaration row → their links resolve a source_url (the OFFICIAL's own document, even for
// the family link); the others do not (NULL).
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
-- Кмет's family stake is declared IN his OWN asset declaration (decl:k), so its source_url resolves to HIS
-- document — never a relative's. That is the ADR-0032 provenance rail, exercised by the base fixture.
INSERT INTO declarations (id, person_id, xml_file, control_hash, folder_year, declared_year, template, category, institution, position, source_url) VALUES
  ('decl:i','person:ivan','i.xml','H1','2024','2023','assets','','ТЕСТ','', 'https://register.cacbg.bg/2024/i.xml'),
  ('decl:k','person:kmet','k.xml','H2','2021','2020','assets','','ОБЩИНА','', 'https://register.cacbg.bg/2021/k.xml');
INSERT INTO declared_interests (id, declaration_id, entity_raw, entity_key, kind, detail, timing, seat) VALUES
  ('di:i','decl:i','ТРЕЙС ГРУП ХОЛД АД','ТРЕЙС ГРУП ХОЛД АД','shares','','annual',''),
  ('di:k','decl:k','ЕВРОСТРОЙ 21 ЕООД','ЕВРОСТРОЙ 21 ЕООД','shares','','annual','');
INSERT INTO interest_links
  (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
  ('il:ivan','person:ivan|111','person:ivan','eik:111','111','ТРЕЙС ГРУП ХОЛД АД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'exact',1,'2019','2023',35,88000000,'2021','2024','published'),
  ('il:boris','person:boris|222','person:boris','eik:222','222','ХОЛДИНГ 9 ЕАД','exact_name_key','v1','B_distinctive','manages','ex_officio_board',0,'none',1,'2023','2023',10,5000000,'2023','2023','published'),
  ('il:viktor','person:viktor|222','person:viktor','eik:222','222','ХОЛДИНГ 9 ЕАД','exact_name_key','v1','B_distinctive','manages','ex_officio_board',0,'none',1,'2023','2023',10,5000000,'2023','2023','published'),
  -- family_ownership now PUBLISHES on the named surface (ADR-0032, superseding ADR-0030), identically to a
  -- self stake — relation 'related', the relative unnamed. Кмет's standalone relative stake (€250k) surfaces
  -- as a 'related' row. own_institution='none' so he ranks in the non-exact tier; eik 333 has a live contract
  -- (c:33) so the N9 read gate keeps him.
  ('il:fam','person:kmet|333|family','person:kmet','eik:333','333','ЕВРОСТРОЙ 21 ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',1,'none',1,'2018','2020',5,250000,'2019','2020','published'),
  ('il:big','person:big|444','person:big','eik:444','444','ГОЛЯМ ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2021',10,50000000,'2020','2021','published'),
  -- Двоен declared BOTH his OWN stake and a RELATIVE's stake in П2АРХ (eik 555): two published links, same
  -- winner, same €79k. The own stake already names him on the winner, so the redundant-family collapse
  -- (ADR-0032) DROPS the family link — only the 'owns' row surfaces. This is the de-anonymization + double-
  -- count guard: where a self stake exists, the relative row adds nothing but a ТР re-identification path.
  ('il:dual-self','person:dual|555','person:dual','eik:555','555','П2АРХ ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2022',4,79000,'2021','2022','published'),
  ('il:dual-fam','person:dual|555|family','person:dual','eik:555','555','П2АРХ ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2022',4,79000,'2021','2022','published'),
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
  ('t:3','unp3','Т3','a:1','открита процедура'),('t:4','unp4','Т4','a:1','неизвестна'),
  ('t:33','unp33','Обект Евространой','a:1','открита процедура'),
  ('t:44','unp44','Обект Голям','a:1','открита процедура'),
  ('t:55','unp55','Обект Двоен','a:1','открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES
  ('c:1','t:1','eik:111',10000000,'EUR','2020-05-01','Д-1',10000000),
  ('c:2','t:2','eik:111',20000000,'EUR','2023-07-01','Д-2',20000000),
  ('c:3','t:3','eik:111',5000000,'EUR','2024-02-01','Д-3',5000000),
  ('c:4','t:4','eik:111',1000000,'EUR',NULL,'Д-4',1000000),
  -- Кмет's relative's company (eik 333, declared 2018–2020) has one contract signed 2019 — IN-window, so the
  -- family link surfaces as a contemporaneous 'related' row (contemp=1 / €250k) and N9 keeps it.
  ('c:33','t:33','eik:333',250000,'EUR','2019-05-01','Д-33',250000),
  -- Голям (eik 444, declared 2020–2021) has a €50M contract signed 2021 — IN-window, so contemporaneous>0:
  -- he ranks below Иван (own-institution) but above Двоен on the live contemporaneous tier (N8), and the
  -- read-time zero-contract gate (N9) keeps him — his winner has real contracts.
  ('c:44','t:44','eik:444',50000000,'EUR','2021-06-01','Д-44',50000000),
  -- Двоен (eik 555, declared 2020–2022) has one contract signed 2023 — AFTER his window, so his live
  -- contemporaneous count is 0 (the „no in-window contracts" example); still surfaces (N9: has contracts).
  ('c:55','t:55','eik:555',79000,'EUR','2023-03-01','Д-55',79000);
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

  it('leaderboard surfaces self AND family ownership (ADR-0032), NEXUS-ranked; redundant family collapsed; held/withdrawn/ex-officio excluded', () => {
    withDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      // Excluded: held €1000, withdrawn €2M, both ex-officio board links (class gate). Surfaced: Иван (own,
      // exact nexus), Голям (own, €50M contemp), Кмет (family, €250k contemp), and Двоен ONCE — he declared
      // both an own AND a relative's stake in the same winner, so the redundant-family collapse (ADR-0032)
      // drops the family row and keeps his own. Кмет's standalone relative stake survives (no self link).
      expect(board.map((r) => r.official)).toEqual([
        'Иван Минев',
        'Голям Официал',
        'Кмет Тестов',
        'Двоен Тестов',
      ]);
      // Кмет's stake is a relative's → it surfaces as a 'related' row (never named as his own ownership).
      expect(board.find((r) => r.official === 'Кмет Тестов')!.relation).toBe('related');
      // Двоен appears once, as his OWN stake — the redundant family row collapsed away.
      const dvoen = board.filter((r) => r.official === 'Двоен Тестов');
      expect(dvoen).toHaveLength(1);
      expect(dvoen[0]!.relation).toBe('owns');
      // NEXUS-first: Иван (own institution) leads; Голям (€50M, no nexus but contemporaneous) is next.
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

  it('a family link surfaces with the OFFICIAL’s own declaration as provenance — never the relative’s (ADR-0032)', () => {
    withDb((dbPath) => {
      // The family stake is declared IN Кмет's own asset declaration (decl:k), so source_url resolves to HIS
      // document. The relative is never named; the row carries relation 'related' and points only at the
      // office-holder's public filing — the same provenance rail as a self link.
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      const kmet = board.find((r) => r.official === 'Кмет Тестов')!;
      expect(kmet.relation).toBe('related');
      expect(kmet.source_url).toBe('https://register.cacbg.bg/2021/k.xml'); // Кмет's OWN declaration
      const ivan = board.find((r) => r.official === 'Иван Минев')!;
      expect(ivan.source_url).toBe('https://register.cacbg.bg/2024/i.xml');
    });
  });

  it('a family link whose winner has no live contracts is gated out (N9) — same read gate as a self link', () => {
    withDb((dbPath) => {
      // A published family link whose company won ZERO contracts is not a procurement conflict; the read-time
      // N9 gate (EXISTS a contract) drops it exactly as it would a self link — no special family handling.
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:666','НУЛА ООД','666','666',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:zero','Нула Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:zerofam','person:zero|666|family','person:zero','eik:666','666','НУЛА ООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2021',0,0,NULL,NULL,'published');`,
      );
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.some((r) => r.official === 'Нула Тестов')).toBe(false); // no live contracts → gated out
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

  it('a family (close-relative) link surfaces on the winner and official view as a "related" row (ADR-0032)', () => {
    withDb((dbPath) => {
      // ЕВРОСТРОЙ (eik 333) carries Кмет's family stake → the company view shows it, and Кмет's official page
      // shows the single 'related' link. The office-holder is named; the RELATIVE is never named (relation is
      // 'related', no holder identity anywhere on the row).
      const company = rows(dbPath, lit(COMPANY_SQL, '333'));
      expect(company).toHaveLength(1);
      expect(company[0]!.official).toBe('Кмет Тестов');
      expect(company[0]!.relation).toBe('related');
      const official = rows(dbPath, lit(OFFICIAL_SQL, 'person:kmet'));
      expect(official).toHaveLength(1);
      expect(official[0]!.relation).toBe('related');
      expect(official[0]!.company).toBe('ЕВРОСТРОЙ 21 ЕООД');
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

  it('collapses the redundant family link when the official also declared an own stake in the same winner (ADR-0032)', () => {
    withDb((dbPath) => {
      // Двоен has an own stake (private_ownership) AND a relative's stake (family_ownership) in П2АРХ. The own
      // stake already names him on the winner, so the family row would only re-point at the same company via a
      // relative — a ТР de-anonymization vector AND a money double-count. ADR-0032's redundant-family collapse
      // drops the family row wherever a published self stake exists on the same (official, ЕИК); only 'owns' survives.
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

  it('collapses the redundant family link even when it resolved a variant bidder row for the same ЕИК (ADR-0032)', () => {
    withDb((dbPath) => {
      // ONE eik ('800') on TWO bidder rows: Дубъл's own stake → 'eik:800', his relative's stake → 'eik:800b'
      // (same company, a name variant, different bidder_id). The collapse keys on (person_id, ЕИК), NOT
      // bidder_id — so the redundant family link drops despite pointing at a different bidder row; only 'owns' survives.
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
           ('eik:800','ДУБЪЛ ЕООД','800','800',1,'company'),
           ('eik:800b','ДУБЪЛ ЕООД (вариант на име)',NULL,'800',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:dubl','Дубъл Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:dubl-self','person:dubl|800','person:dubl','eik:800','800','ДУБЪЛ ЕООД','exact_name_key','v1','B_distinctive','owns','private_ownership',0,'none',1,'2020','2022',2,60000,'2021','2022','published'),
           ('il:dubl-fam','person:dubl|800|family','person:dubl','eik:800b','800','ДУБЪЛ ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2022',2,60000,'2021','2022','published');
         INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:80','unp80','Обект Дубъл','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES ('c:80','t:80','eik:800',60000,'EUR','2021-05-01','Д-80',60000);`,
      );
      // COMPANY view for eik 800: the family link collapses (a self stake exists on ЕИК 800) → one 'owns' row.
      const company = rows(dbPath, lit(COMPANY_SQL, '800'));
      expect(company).toHaveLength(1);
      expect(company[0]!.relation).toBe('owns');
      const official = rows(dbPath, lit(OFFICIAL_SQL, 'person:dubl'));
      expect(official).toHaveLength(1);
      expect(official[0]!.relation).toBe('owns');
    });
  });

  it('a family link SURVIVES the collapse when the official’s self stake in the same winner is NOT published (held/withdrawn) — the collapse keys on a PUBLISHED self stake (ADR-0032)', () => {
    withDb((dbPath) => {
      // The collapse drops a family row ONLY where a PUBLISHED self stake already names the official on that
      // winner. If the self stake is held/withdrawn/suppressed it never surfaced — so the family link is the
      // ONLY public signal for that (official, ЕИК) and MUST survive. This pins the s.status='published' guard
      // inside NOT_REDUNDANT_FAMILY: dropping it (collapsing on ANY self stake) would silently bury a real,
      // standalone family conflict behind a self stake the public never sees.
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:850','АСИМ ЕООД','850','850',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:asim','Асим Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:asim-self-held','person:asim|850','person:asim','eik:850','850','АСИМ ЕООД','exact_name_key','v1','C_hold','owns','private_ownership',0,'none',1,'2020','2022',2,40000,'2021','2022','held'),
           ('il:asim-fam','person:asim|850|family','person:asim','eik:850','850','АСИМ ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',0,'none',1,'2020','2022',2,40000,'2021','2022','published');
         INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:85','unp85','Обект Асим','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES ('c:85','t:85','eik:850',40000,'EUR','2021-05-01','Д-85',40000);`,
      );
      // The self stake is HELD (never surfaces), so the family link is NOT redundant → it survives as the one
      // published row for ЕИК 850, on both the company and the official view.
      const company = rows(dbPath, lit(COMPANY_SQL, '850'));
      expect(company).toHaveLength(1);
      expect(company[0]!.relation).toBe('related');
      const official = rows(dbPath, lit(OFFICIAL_SQL, 'person:asim'));
      expect(official).toHaveLength(1);
      expect(official[0]!.relation).toBe('related');
      // …and its /contracts drill-down works — the family key is the surviving surface, not a dead link.
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:asim|850|family'))).toHaveLength(1);
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
      // a link with contracts but NONE in the window reports 0 / NULL, not a fabricated figure. Двоен's one
      // contract (2023) is after his 2020–2022 window — he has contracts (so N9 keeps him) but 0 in-window.
      const dvoen = board.find((r) => r.official === 'Двоен Тестов')!;
      expect(dvoen.contemporaneous_contract_count).toBe(0);
      expect(dvoen.contemporaneous_value_eur).toBeNull();
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

  it('the /contracts drill-down collapses a redundant family link_key but serves the surviving self key (ADR-0032)', () => {
    withDb((dbPath) => {
      // Двоен's own and family links both point at П2АРХ (eik 555). The self key serves eik 555's one contract
      // (c:55); the family key collapses (a published self stake exists on the same ЕИК) and serves nothing —
      // the same read gate the surface applies, so a drilled-down family URL can't resurrect the collapsed link.
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:dual|555'))).toHaveLength(1);
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:dual|555|family'))).toHaveLength(0);
    });
  });

  it('a STANDALONE family link serves its contracts on /contracts (ADR-0032)', () => {
    withDb((dbPath) => {
      // Кмет declared only a RELATIVE's stake in ЕВРОСТРОЙ (eik 333) — no own stake. Under ADR-0032 the family
      // link publishes, so its drill-down returns eik 333's contract (c:33 from the base fixture) — a real
      // procurement-nexus conflict with a working drill-down, the relative never named.
      const list = rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:kmet|333|family'));
      expect(list).toHaveLength(1);
      expect(list[0]!.contract_number).toBe('Д-33');
    });
  });

  it('read-time zero-contract gate: a published link whose winner has no live contracts drops off the surface (N9)', () => {
    withDb((dbPath) => {
      // A published own-stake link whose winner currently has NO contract rows (e.g. the EOP corpus was
      // refreshed after the свързани-лица ship). The frozen contract_count says 7, but the read must gate on
      // LIVE contract existence — the link must not linger on the leaderboard only to expand to „no contracts".
      sqlite(
        dbPath,
        `INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:900','ПРАЗЕН ООД','900','900',1,'company');
         INSERT INTO persons (id, name) VALUES ('person:praz','Празен Тестов');
         INSERT INTO interest_links
           (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version, publish_tier, relation, interest_class, contemporaneous, own_institution, evidence_count, first_declared_year, last_declared_year, contract_count, contract_value_eur, first_contract_year, last_contract_year, status) VALUES
           ('il:praz','person:praz|900','person:praz','eik:900','900','ПРАЗЕН ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'exact',1,'2020','2022',7,7000000,'2021','2022','published');`,
      );
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      expect(board.some((r) => r.official === 'Празен Тестов')).toBe(false); // gated out — no live contracts
      expect(rows(dbPath, lit(OFFICIAL_SQL, 'person:praz'))).toHaveLength(0); // official view 404s too
      expect(rows(dbPath, lit(COMPANY_SQL, '900'))).toHaveLength(0);
    });
  });

  it(`caps one link's expanded contract list at LINK_CONTRACTS_LIMIT — a huge winner cannot return an unbounded payload (ydimitrof #226: perf/DoS)`, () => {
    withDb((dbPath) => {
      // Give Иван's winner (eik 111) far more than the cap. A recursive CTE mints LIMIT+100 in-window
      // contracts (2021, inside his 2019–2023 span) so ORDER BY keeps them all eligible; the query must
      // still return exactly LINK_CONTRACTS_LIMIT rows, never the whole set.
      const extra = LINK_CONTRACTS_LIMIT + 100;
      sqlite(
        dbPath,
        `INSERT INTO tenders (id, source_id, title, authority_id, procedure_type)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${extra})
           SELECT 'tt:'||i, 'unpN'||i, 'Обект '||i, 'a:1', 'открита процедура' FROM n;
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${extra})
           SELECT 'cc:'||i, 'tt:'||i, 'eik:111', 1000, 'EUR', '2021-06-01', 'ДN-'||i, 1000 FROM n;`,
      );
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:ivan|111'))).toHaveLength(
        LINK_CONTRACTS_LIMIT,
      );
    });
  });
});
