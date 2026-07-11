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
} from './queries/related-persons';

// Integration test for the свързани-лица SQL. The query layer's unit tests (queries/related-persons.test)
// use a fake D1 and never run the aggregation; this runs the EXACT exported SQL against a real SQLite
// built from the production migrations (0000 + 0002) with a deterministic fixture, asserting the private
// vs ex-officio separation (ADR-0019), the value ordering, and the source_url provenance subquery.
// Mirrors the sqlite3-CLI harness of competition-sql.test.ts (no better-sqlite3 dependency).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2 = resolve(root, 'packages/db/migrations/0002_related_persons_foundation.sql');

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
// ЕВРОСТРОЙ (family_ownership, own institution, €250k — anonymized). Голям owns ГОЛЯМ (private, €50M, NO
// nexus) — a high-value link with no own-institution tie, to prove NEXUS-first ordering beats raw value.
// Only Иван has a declaration row → his link resolves a source_url; the others do not (NULL).
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
  ('il:fam','person:kmet|333|family','person:kmet','eik:333','333','ЕВРОСТРОЙ 21 ЕООД','exact_name_key','v1','B_distinctive','related','family_ownership',1,'exact',1,'2018','2020',5,250000,'2019','2020','published'),
  ('il:big','person:big|444','person:big','eik:444','444','ГОЛЯМ ООД','exact_name_key','v1','B_distinctive','owns','private_ownership',1,'none',1,'2020','2021',10,50000000,'2020','2021','published'),
  -- Двоен declared BOTH his OWN stake and a RELATIVE's stake in П2АРХ (eik 555): two published links, same
  -- winner, same €79k. The surface must collapse them to the own-stake row — else €79k is counted twice and
  -- Двоен appears twice for one company (de-anon). own_inst='none'/contemp=0 → ranks after Голям.
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

  it('leaderboard returns material ownership (self + family), NEXUS-ranked; held/withdrawn/ex-officio excluded', () => {
    withDb((dbPath) => {
      const board = rows(dbPath, lit(LEADERBOARD_SQL, 100));
      // held €1000, withdrawn €2M, both ex-officio board links, and Двоен's redundant family link are
      // excluded → 4 material nexuses remain (Двоен's own+relative stakes collapse to one own-stake row)
      expect(board.map((r) => r.official)).toEqual([
        'Иван Минев',
        'Кмет Тестов',
        'Голям Официал',
        'Двоен Тестов',
      ]);
      // NEXUS-first: the €250k family link (own institution) OUTRANKS the €50M link with no nexus — the
      // old value-only ordering would have put Голям (€50M) first. This is the anti-noise fix.
      expect(board[1]!.official).toBe('Кмет Тестов');
      expect(board[1]!.relation).toBe('related'); // family stake — the relative is anonymized in the UI
      expect(board[2]!.official).toBe('Голям Официал'); // highest value, but no nexus → ranked last
      // Иван's private stake keeps its provenance + declared span
      expect(board[0]!.official).toBe('Иван Минев');
      expect(board[0]!.contract_value_eur).toBe(88_000_000);
      expect(board[0]!.first_declared_year).toBe('2019');
      expect(board[0]!.last_declared_year).toBe('2023');
      expect(board[0]!.source_url).toBe('https://register.cacbg.bg/2024/i.xml');
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

  it('a family (close-relative) link surfaces on the winner + official views, carrying relation=related', () => {
    withDb((dbPath) => {
      const byCompany = rows(dbPath, lit(COMPANY_SQL, '333'));
      expect(byCompany).toHaveLength(1);
      expect(byCompany[0]!.official).toBe('Кмет Тестов'); // official named (their public declaration)
      expect(byCompany[0]!.company).toBe('ЕВРОСТРОЙ 21 ЕООД'); // company named (public winner)
      expect(byCompany[0]!.relation).toBe('related'); // holder anonymized as свързано лице in the UI layer
      const byOfficial = rows(dbPath, lit(OFFICIAL_SQL, 'person:kmet'));
      expect(byOfficial.map((r) => r.relation)).toEqual(['related']);
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

  it('collapses (official, company) to ONE nexus when an official declared both their own and a relative’s stake in the same winner (no €-double-count, no de-anon)', () => {
    withDb((dbPath) => {
      // Двоен has TWO published links to П2АРХ (own → private_ownership, relative → family_ownership). The
      // own-stake link wins; the relative link is dropped on every surface so €79k is counted once and the
      // official is not shown twice for one company. (The standalone family link at eik 333 still surfaces —
      // proved by the family test above — so the dedup does not over-reach.)
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

  it('the /contracts route hides a family link the leaderboard collapsed away (de-anon oracle closed)', () => {
    withDb((dbPath) => {
      // Двоен's family link to П2АРХ (eik 555) is dropped from every surface because his published self stake
      // exists for the same winner. Give eik 555 a real contract, so the ONLY reason the family key can return
      // [] is the collapse predicate — not an empty contract set. Pre-fix, the family key leaked this contract,
      // an existence-oracle confirming the suppressed relative stake (ADR-0023 de-anon vector).
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

  it('a STANDALONE family link (no self sibling) is NOT over-collapsed — /contracts still serves it', () => {
    withDb((dbPath) => {
      // Кмет declared only a RELATIVE's stake in ЕВРОСТРОЙ (eik 333) — no own stake. The collapse predicate
      // must NOT fire (it drops a family link only when a published SELF link exists for the same winner),
      // so this legitimate family conflict's contract drill-down keeps working. Guards the over-collapse
      // direction: the oracle fix must not blind a real relative-ownership conflict.
      sqlite(
        dbPath,
        `INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES ('t:8','unp8','Обект','a:1','открита процедура');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, amount_eur) VALUES ('c:8','t:8','eik:333',250000,'EUR','2019-05-01','Д-8',250000);`,
      );
      expect(rows(dbPath, lit(LINK_CONTRACTS_SQL, 'person:kmet|333|family'))).toHaveLength(1);
    });
  });
});
