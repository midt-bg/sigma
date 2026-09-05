/// <reference types="node" />
// PR #183 review (lyubomir-bozhinov, 2026-08-24, MAJOR #1): listCompanies's COLS includes
// `legal_form` (toCompanyListItem reads it for natural-person masking — PR #183 T-001), but the
// rollup branch of source() only projects it when the CSV streamer asks for it (the
// `3cd5d23 perf(db): project legal_form only on the CSV path` optimization predates the masking
// mapper). On a real D1 the SELECT therefore fails with `no such column: legal_form` at offset
// N, and `/companies` + `/companies.data` return 500. The existing mocked-DB unit suite never
// executes the SQL, so the bug shipped.
//
// This file replays the production SQL listCompanies emits, against the real D1 schema, on a real
// SQLite engine (Node 22's `node:sqlite`). The tests are end-to-end for the SQL projection: a
// passing run means listCompanies can execute against a D1 instance and that masking round-trips.
//
// The shape mirrors packages/db/src/queries/value-base-sql.test.ts (real-SQLite end-to-end of
// the production rollups), and uses the same `d1()` shim to expose `node:sqlite` as D1Database.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';
import { listCompanies, streamCompaniesCsv } from './companies';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'));

/** Minimal D1 facade over node:sqlite; no sqlite3 or wrangler subprocess is involved. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: (string | number | null)[] = [];
      const statement = {
        bind(...params: (string | number | null)[]) {
          bound = params;
          return statement;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...bound) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...bound) ?? null) as T | null;
        },
        async run() {
          db.prepare(sql).run(...bound);
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

// Three companies: one sole trader (legal_form='ЕТ'), one legal entity (legal_form='ООД'), and one
// consortium whose lead member is a sole trader (the over-mask guard target). Mirrors the seed
// used in apps/web's integration lane for the privacy noindex proof (the lyubomir-bozhinov review
// observation).
const FIXTURE = `
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind, legal_form, settlement)
VALUES
  ('eik:999000111', 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ', '999000111', '999000111', 1, 0, 'company',  'ЕТ',  'София'),
  ('eik:200000002', 'СТРОЙ ООД',              '200000002', '200000002', 1, 0, 'company',  'ООД', 'Пловдив'),
  ('eik:300000003', 'ЕТ Иван Петров; Строй ООД','300000003', '300000003', 1, 1, 'consortium', 'ДЗЗД', 'Варна');
INSERT INTO company_totals
  (bidder_id, name, kind, eik, eik_valid, settlement, won_eur, contracts, authorities, eu_eur, first_date, last_date)
VALUES
  ('eik:999000111', 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ', 'company',   '999000111', 1, 'София',   9000000.0,  5, 1, 0, '2021-01-01', '2022-12-01'),
  ('eik:200000002', 'СТРОЙ ООД',              'company',   '200000002', 1, 'Пловдив', 8000000.0, 50, 1, 0, '2020-01-01', '2022-12-28'),
  ('eik:300000003', 'ЕТ Иван Петров; Строй ООД','consortium', '300000003', 1, 'Варна',   7000000.0, 10, 1, 0, '2021-01-01', '2022-06-01');
`;

let open: DatabaseSync | null = null;

function realDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(FIXTURE);
  open = sqlite;
  return { sqlite, db: d1(sqlite) };
}

afterEach(() => {
  open?.close();
  open = null;
});

describe('listCompanies on real SQLite — rollup branch must include legal_form (PR #183 review MAJOR)', () => {
  // Regression for PR #183 review (lyubomir-bozhinov, 2026-08-24, MAJOR #1): the previous
  // `3cd5d23 perf(db): project legal_form only on the CSV path` commit assumed `toCompanyListItem`
  // did not consume `legal_form`, but `3458dae fix(privacy): mask sole-trader rows in leaderboard
  // list mappers` later added `r.legal_form` consumption to the mapper without updating the SQL
  // source. The result is a SELECT that names `legal_form` against a FROM that does not project
  // it. The mocked-DB unit suite passes because it returns rows directly without running SQL.
  // On real D1 this returns 500 for `/companies` and `/companies.data`.

  it('does not throw `no such column: legal_form` on the unfiltered rollup branch', async () => {
    // Direct replay of the SQL listCompanies builds (matches companies.ts:65 COLS and
    // companies.ts:182 SELECT). No need to call listCompanies itself — the assertion is purely
    // that the column projection round-trips against the real schema.
    const { db } = realDb();
    await expect(listCompanies(db, {})).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it('masks a sole trader (legal_form=ЕТ) on the rollup branch — ЕИК null + label replaced', async () => {
    const { db } = realDb();
    const page = await listCompanies(db, {});
    // Pre-fix the slug was the bare ЕИК (a privacy leak: masked rows still advertised the ЕИК on
    // /companies.data and in the hydration stream). Now the slug is an opaque `m<base64(bidder_id)>`
    // token — find the masked row by its masking signal instead.
    const et = page.items.find((i) => i.masked && i.eik === null);
    expect(et).toBeDefined();
    expect(et?.slug).not.toBe('999000111');
    expect(et?.slug).not.toMatch(/^\d{9}(\d{4})?$/);
    expect(et?.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(et?.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(et?.hasEik).toBe(false);
  });

  it('keeps a legal entity (legal_form=ООД) verbatim on the rollup branch', async () => {
    const { db } = realDb();
    const page = await listCompanies(db, {});
    const ood = page.items.find((i) => i.slug === '200000002');
    expect(ood).toBeDefined();
    expect(ood?.eik).toBe('200000002');
    expect(ood?.name).toBe('СТРОЙ ООД');
    expect(ood?.hasEik).toBe(true);
  });

  it('does NOT over-mask a consortium whose lead member is a sole trader (kind guard)', async () => {
    const { db } = realDb();
    const page = await listCompanies(db, {});
    const consortium = page.items.find((i) => i.slug === '300000003');
    expect(consortium).toBeDefined();
    expect(consortium?.isConsortium).toBe(true);
    expect(consortium?.eik).toBe('300000003');
    expect(consortium?.name).toBe('ЕТ Иван Петров; Строй ООД');
  });

  it('round-trips with streamCompaniesCsv on the same rollup rows (parity between two surfaces)', async () => {
    // The list mapper and the CSV streamer both mask the same sole-trader row through
    // isNaturalPersonBidder(r.legal_form). On the rollup branch the SQL must project legal_form
    // for BOTH, otherwise the list 500s while the CSV silently emits masked output.
    const { db } = realDb();
    const page = await listCompanies(db, {});
    const csv = await streamCompaniesCsv(db, {}).text();
    const csvLines = csv.trim().split('\n').slice(1); // skip header
    const header = csv.trim().split('\n')[0]!.split(',');
    const eikIdx = header.indexOf('eik');
    const nameIdx = header.indexOf('name');

    // Find the masked list row by its masking signal — the slug is now opaque for masked rows.
    const etFromList = page.items.find((i) => i.masked && i.eik === null);
    expect(etFromList?.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(etFromList?.eik).toBeNull();

    // CSV orders by bidder_id ASC: eik:200000002, eik:300000003, eik:999000111 — the masked
    // sole-trader row is the third. Identify it by its masked-name token rather than position so
    // the assertion survives fixture re-orderings.
    const csvEtLine = csvLines.find(
      (line) => line.split(',')[nameIdx] === MASKED_NATURAL_PERSON_LABEL,
    );
    expect(csvEtLine).toBeDefined();
    expect(csvEtLine!.split(',')[eikIdx]).toBe(''); // CSV writes empty ЕИК for masked rows
  });
});
