import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1FromSqlite, fakeD1, throwingD1 } from '@sigma/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEGRADED_REUSE_MS, health, HEALTH_REUSE_MS, healthResponse, reusedHealth } from './health';

// The reads run as real SQL against the served schema the migrations build, so a renamed column fails
// here rather than in a deploy check. The tables the runs create on first use are created from the DDL
// the runs themselves carry, read from their source, so neither side can drift from a copy here.

const NOW = new Date('2000-06-01T12:00:00.000Z');
const OVERLOADED = 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.';
const HOLDER = 'synthetic-holder-7f3a';
const REPO = resolve(import.meta.dirname, '../../..');

function servedSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const migrations = resolve(REPO, 'packages/db/migrations');
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(resolve(migrations, file), 'utf8'));
  return db;
}

/** The DDL a run creates its table with, as written in the run's own source. */
function runDdl(file: string, pattern: RegExp): string {
  const ddl = pattern.exec(readFileSync(resolve(REPO, file), 'utf8'))?.[1];
  if (!ddl) throw new Error(`${file} no longer holds the DDL this test reads (${pattern})`);
  return ddl;
}
const PENDING_WINDOW_DDL = runDdl(
  'packages/ingest/src/refresh.ts',
  /const PENDING_WINDOW_DDL = `([^`]+)`/,
);
const RP_GENERATION_DDL = runDdl(
  'scripts/ship-related-persons.mjs',
  /'(CREATE TABLE IF NOT EXISTS rp_generation [^']+)'/,
);

function published(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, as_of, refreshed_at)
      VALUES (1, 3, 100, 1, 1, 0, '2000-05-30', '2000-05-31 04:05:06');
    INSERT INTO data_version (id, version, source_commit, built_at, run_id)
      VALUES (1, 5, '0123456789abcdef0123456789abcdef01234567', '2000-05-01T00:00:00Z', 'synthetic-run');
    INSERT INTO registry_sync (id, holder, expires_at)
      VALUES (1, '${HOLDER}', '2000-06-01T12:05:00.000Z');
    INSERT INTO registry_entry_state (id, seeded_through) VALUES (1, '2000-05-29');
  `);
}

function withPendingWindows(db: DatabaseSync): void {
  db.exec(PENDING_WINDOW_DDL);
  db.exec(`
    INSERT INTO refresh_pending_window VALUES ('${HOLDER}', '2000-05-28', '2000-05-30', '2000-05-31T03:00:00.000Z');
    INSERT INTO refresh_pending_window VALUES ('other', '2000-05-30', '2000-05-31', '2000-05-31T09:00:00.000Z');
  `);
}

function withRelatedPersons(db: DatabaseSync): void {
  db.exec(RP_GENERATION_DDL);
  db.exec(`INSERT INTO rp_generation VALUES ('synthetic-rp-run', '2000-05-27T08:00:00Z')`);
}

const env = (DB: D1Database) => ({ DB }) as unknown as Env;

// The report is reused per isolate for a few seconds; every test starts well past the last one's.
let clock = NOW.getTime();
beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  vi.stubGlobal('__SIGMA_VERSION__', 'abcdef012345');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('health', () => {
  it('reports the code, the data generation and what the runs left on record', async () => {
    const db = servedSchema();
    published(db);
    withPendingWindows(db);
    withRelatedPersons(db);
    const DB = d1FromSqlite(db);
    const prepare = vi.spyOn(DB, 'prepare');

    expect(await health(env(DB), NOW)).toEqual({
      status: 'ok',
      db: 'ok',
      checkedAt: '2000-06-01T12:00:00.000Z',
      code: { commit: 'abcdef012345' },
      data: {
        version: 5,
        builtAt: '2000-05-01T00:00:00Z',
        builtFromCommit: '0123456789ab',
        generation: '2000-05-31 04:05:06',
        asOf: '2000-05-30',
      },
      runs: {
        refresh: {
          publishedAt: '2000-05-31 04:05:06',
          unsettledWindows: 2,
          // The oldest window was recorded 33 hours before NOW.
          oldestUnsettledAgeSeconds: 33 * 3600,
        },
        registry: { changesThrough: '2000-05-29' },
        declarations: { relatedPersonsPublishedAt: '2000-05-27T08:00:00Z' },
      },
    });
    // The single-row tables with the list of run tables, then both run tables: two statements.
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('reads the register position from the marker the registry run advances', () => {
    // A column that no run writes reports nothing for ever: the read follows the run's own write.
    const run = readFileSync(resolve(REPO, 'apps/etl/src/registry.ts'), 'utf8');
    expect(run).toMatch(/UPDATE registry_entry_state SET seeded_through=/);
    const report = readFileSync(resolve(REPO, 'apps/web/workers/health.ts'), 'utf8');
    expect(report).toMatch(/r\.seeded_through AS changes_through/);
    expect(report).toMatch(/LEFT JOIN registry_entry_state r ON r\.id = 1/);
  });

  it('answers on a slot no run has touched yet with one statement', async () => {
    const db = servedSchema();
    db.exec(`INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, refreshed_at)
      VALUES (1, 0, 0, 0, 0, 0, '2000-05-31 04:05:06')`);
    const DB = d1FromSqlite(db);
    const prepare = vi.spyOn(DB, 'prepare');

    const report = await health(env(DB), NOW);

    expect(report.status).toBe('ok');
    expect(report.data).toEqual({
      version: null,
      builtAt: null,
      builtFromCommit: null,
      generation: '2000-05-31 04:05:06',
      asOf: null,
    });
    expect(report.runs).toEqual({
      refresh: {
        publishedAt: '2000-05-31 04:05:06',
        unsettledWindows: 0,
        oldestUnsettledAgeSeconds: null,
      },
      registry: { changesThrough: null },
      declarations: { relatedPersonsPublishedAt: null },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('reads only the run table that exists', async () => {
    const onlyWindows = servedSchema();
    published(onlyWindows);
    onlyWindows.exec(PENDING_WINDOW_DDL);
    expect((await health(env(d1FromSqlite(onlyWindows)), NOW)).runs).toEqual({
      refresh: {
        publishedAt: '2000-05-31 04:05:06',
        unsettledWindows: 0,
        oldestUnsettledAgeSeconds: null,
      },
      registry: { changesThrough: '2000-05-29' },
      declarations: { relatedPersonsPublishedAt: null },
    });

    const onlyRelated = servedSchema();
    published(onlyRelated);
    withRelatedPersons(onlyRelated);
    expect((await health(env(d1FromSqlite(onlyRelated)), NOW)).runs).toEqual({
      refresh: {
        publishedAt: '2000-05-31 04:05:06',
        unsettledWindows: 0,
        oldestUnsettledAgeSeconds: null,
      },
      registry: { changesThrough: '2000-05-29' },
      declarations: { relatedPersonsPublishedAt: '2000-05-27T08:00:00Z' },
    });
  });

  it('gives no age for a window whose start it cannot read, and never a negative one', async () => {
    const { db } = fakeD1([
      { when: 'JOIN home_totals', first: { has_windows: 1, has_related: 0 } },
      {
        when: 'COUNT(*) FROM refresh_pending_window',
        first: { unsettled: 1, unsettled_since: 'not a time' },
      },
    ]);
    expect((await health(env(db), NOW)).runs.refresh).toMatchObject({
      unsettledWindows: 1,
      oldestUnsettledAgeSeconds: null,
    });

    const ahead = fakeD1([
      { when: 'JOIN home_totals', first: { has_windows: 1, has_related: 0 } },
      {
        when: 'COUNT(*) FROM refresh_pending_window',
        first: { unsettled: null, unsettled_since: '2000-06-01T12:00:30.000Z' },
      },
    ]);
    expect((await health(env(ahead.db), NOW)).runs.refresh).toMatchObject({
      unsettledWindows: 0,
      oldestUnsettledAgeSeconds: 0,
    });
  });

  it('is degraded, not an error, when D1 refuses the read', async () => {
    const report = await health(env(throwingD1(new Error(OVERLOADED)).db), NOW);

    expect(report).toMatchObject({
      status: 'degraded',
      db: 'overloaded',
      code: { commit: 'abcdef012345' },
      data: { version: null, generation: null },
      runs: { refresh: { unsettledWindows: null, oldestUnsettledAgeSeconds: null } },
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"health_degraded"'));
  });

  it('names any other failed read as a database error', async () => {
    const report = await health(env(throwingD1(new Error('D1_ERROR: no such table')).db), NOW);
    expect(report).toMatchObject({ status: 'degraded', db: 'error' });
  });

  it('reads an empty answer as nothing recorded', async () => {
    const { db } = fakeD1([{ when: 'JOIN home_totals', first: null }]);
    const report = await health(env(db), NOW);
    expect(report).toMatchObject({ status: 'ok', data: { version: null, generation: null } });
  });

  it('logs a failure that is not an Error by its text', async () => {
    const { db } = fakeD1([
      {
        when: [],
        first: () => {
          throw 'synthetic failure';
        },
      },
    ]);
    const report = await health(env(db), NOW);
    expect(report.db).toBe('error');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('synthetic failure'));
  });

  it('reports no commit outside a deploy', async () => {
    vi.stubGlobal('__SIGMA_VERSION__', '');
    const report = await health(env(throwingD1().db));
    expect(report.code.commit).toBeNull();
  });
});

describe('reusedHealth', () => {
  function counted(): { DB: D1Database; reads: () => number } {
    const db = servedSchema();
    published(db);
    const DB = d1FromSqlite(db);
    const prepare = vi.spyOn(DB, 'prepare');
    return { DB, reads: () => prepare.mock.calls.length };
  }

  it('reads the database once for a burst of reports, and again once the report is old', async () => {
    const { DB, reads } = counted();
    const [first, second] = await Promise.all([reusedHealth(env(DB)), reusedHealth(env(DB))]);
    expect(second).toBe(first);
    vi.setSystemTime(clock + HEALTH_REUSE_MS - 1);
    expect(await reusedHealth(env(DB))).toBe(first);
    expect(reads()).toBe(1);

    vi.setSystemTime(clock + HEALTH_REUSE_MS);
    const fresh = await reusedHealth(env(DB));
    expect(fresh).not.toBe(first);
    expect(fresh.checkedAt).toBe(new Date(clock + HEALTH_REUSE_MS).toISOString());
    expect(reads()).toBe(2);
  });

  it('keeps a degraded report for less time than a healthy one', async () => {
    const refused = throwingD1(new Error(OVERLOADED));
    const degraded = await reusedHealth(env(refused.db));
    expect(degraded.status).toBe('degraded');
    vi.setSystemTime(clock + DEGRADED_REUSE_MS - 1);
    expect(await reusedHealth(env(refused.db))).toBe(degraded);

    vi.setSystemTime(clock + DEGRADED_REUSE_MS);
    const { DB } = counted();
    expect(await reusedHealth(env(DB))).toMatchObject({ status: 'ok', db: 'ok' });
    expect(DEGRADED_REUSE_MS).toBeLessThan(HEALTH_REUSE_MS);
  });
});

describe('healthResponse', () => {
  it('is JSON that no cache may keep', async () => {
    const db = servedSchema();
    published(db);
    const response = await healthResponse(
      new Request('https://example.invalid/health'),
      env(d1FromSqlite(db)),
      true,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(((await response.json()) as { data: { generation: string } }).data.generation).toBe(
      '2000-05-31 04:05:06',
    );
  });

  it('stays no-store when it answers with a reused report', async () => {
    const db = servedSchema();
    published(db);
    const DB = d1FromSqlite(db);
    const request = () => new Request('https://example.invalid/health');
    const first = await healthResponse(request(), env(DB), true);
    const second = await healthResponse(request(), env(DB), true);
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    expect(await second.text()).toBe(await first.text());
  });

  it('carries nothing beyond the technical fields: no lease holder, run id or database binding', async () => {
    const db = servedSchema();
    published(db);
    withPendingWindows(db);
    withRelatedPersons(db);
    const body = await (
      await healthResponse(
        new Request('https://example.invalid/health'),
        env(d1FromSqlite(db)),
        true,
      )
    ).text();

    expect(body).not.toContain(HOLDER);
    expect(body).not.toContain('synthetic-run');
    expect(body).not.toContain('synthetic-rp-run');
    const keys = (value: unknown, prefix = ''): string[] =>
      value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => [
            `${prefix}${key}`,
            ...keys(inner, `${prefix}${key}.`),
          ])
        : [];
    expect(keys(JSON.parse(body)).sort()).toEqual(
      [
        'checkedAt',
        'code',
        'code.commit',
        'data',
        'data.asOf',
        'data.builtAt',
        'data.builtFromCommit',
        'data.generation',
        'data.version',
        'db',
        'runs',
        'runs.declarations',
        'runs.declarations.relatedPersonsPublishedAt',
        'runs.refresh',
        'runs.refresh.oldestUnsettledAgeSeconds',
        'runs.refresh.publishedAt',
        'runs.refresh.unsettledWindows',
        'runs.registry',
        'runs.registry.changesThrough',
        'status',
      ].sort(),
    );
  });

  it('answers a degraded report with a 200, never a 5xx of its own', async () => {
    const response = await healthResponse(
      new Request('https://example.invalid/health'),
      env(throwingD1(new Error(OVERLOADED)).db),
      true,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'degraded', db: 'overloaded' });
  });

  it('refuses a method other than GET without reading anything', async () => {
    const { db, calls } = fakeD1([]);
    const response = await healthResponse(
      new Request('https://example.invalid/health', { method: 'POST' }),
      env(db),
      true,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toEqual([]);
  });
});
