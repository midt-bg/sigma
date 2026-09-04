// Promises of coverage — the record that lets the next run REPLAY an aborted one — on a real SQLite
// behind the D1 facade, because what matters here is the arithmetic on the table, not the SQL text:
// a run records the EXACT range it applies; after its gate passed that range is SUBTRACTED from every
// promise; promises only ever shrink or go, never merge into a hull that could grow to cover days
// already applied (the fifth review's finding).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import {
  pendingWindows,
  recordPendingWindow,
  settlePendingWindows,
  subtractCovered,
} from './refresh';

const AT = new Date('2026-09-02T19:16:00.000Z');
const fresh = () => d1FromSqlite(new DatabaseSync(':memory:'));
const spans = async (db: D1Database) =>
  (await pendingWindows(db)).map((w) => `${w.holder}:${w.from}..${w.to}`);

describe('subtractCovered', () => {
  const w = { from: '2026-05-10', to: '2026-05-25' };
  it('leaves a disjoint promise untouched', () => {
    expect(subtractCovered(w, { from: '2026-06-01', to: '2026-06-07' })).toEqual([w]);
    expect(subtractCovered(w, { from: '2026-04-01', to: '2026-05-09' })).toEqual([w]);
  });
  it('removes a promise the coverage spans', () => {
    expect(subtractCovered(w, { from: '2026-05-10', to: '2026-05-25' })).toEqual([]);
    expect(subtractCovered(w, { from: '2026-05-01', to: '2026-06-01' })).toEqual([]);
  });
  it('keeps the uncovered front, tail, or both', () => {
    expect(subtractCovered(w, { from: '2026-05-18', to: '2026-06-07' })).toEqual([
      { from: '2026-05-10', to: '2026-05-17' },
    ]);
    expect(subtractCovered(w, { from: '2026-05-01', to: '2026-05-15' })).toEqual([
      { from: '2026-05-16', to: '2026-05-25' },
    ]);
    expect(subtractCovered(w, { from: '2026-05-15', to: '2026-05-16' })).toEqual([
      { from: '2026-05-10', to: '2026-05-14' },
      { from: '2026-05-17', to: '2026-05-25' },
    ]);
  });
});

describe('pending windows on SQLite', () => {
  it('reads [] before any promise exists, without creating the table', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = d1FromSqlite(raw);
    expect(await pendingWindows(db)).toEqual([]);
    expect(
      raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'refresh_pending_window'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('records a promise, re-recording the same one replaces rather than duplicates', async () => {
    const db = fresh();
    await recordPendingWindow(db, 'wf-1', '2026-07-07', '2026-07-10', AT);
    await recordPendingWindow(db, 'wf-1', '2026-07-07', '2026-07-11', AT); // a retried step
    expect(await spans(db)).toEqual(['wf-1:2026-07-07..2026-07-11']);
  });

  it('settles: spanned promises go, straddling ones shrink, out-of-reach ones stay', async () => {
    const db = fresh();
    await recordPendingWindow(db, 'dead-1', '2026-04-01', '2026-04-10', AT); // out of reach
    await recordPendingWindow(db, 'dead-2', '2026-05-10', '2026-05-25', AT); // straddles
    await recordPendingWindow(db, 'wf-3', '2026-05-18', '2026-06-07', AT); // this run's own
    const result = await settlePendingWindows(db, { from: '2026-05-18', to: '2026-06-07' }, AT);
    expect(result.settled).toBe(2);
    expect(result.remaining.map((w) => `${w.holder}:${w.from}..${w.to}`)).toEqual([
      'dead-1:2026-04-01..2026-04-10',
      'dead-2:2026-05-10..2026-05-17',
    ]);
    expect(await spans(db)).toEqual([
      'dead-1:2026-04-01..2026-04-10',
      'dead-2:2026-05-10..2026-05-17',
    ]);
  });

  it('settles only the promises the caller marks eligible, reporting the rest as remaining', async () => {
    const db = fresh();
    await recordPendingWindow(db, 'dead', '2026-05-18', '2026-05-20', AT); // inside the coverage
    await recordPendingWindow(db, 'own', '2026-05-18', '2026-06-07', AT);
    const result = await settlePendingWindows(
      db,
      { from: '2026-05-18', to: '2026-06-07' },
      AT,
      (w) => w.holder === 'own',
    );
    expect(result.settled).toBe(1);
    expect(result.remaining.map((w) => w.holder)).toEqual(['dead']);
    expect(await spans(db)).toEqual(['dead:2026-05-18..2026-05-20']);
  });

  it('an interrupted replay never grows a promise (A dies, B capped, C dies, D capped, E wide)', async () => {
    const db = fresh();
    // A promised 04-01..04-10 and died.
    await recordPendingWindow(db, 'A', '2026-04-01', '2026-04-10', AT);
    // B on 06-07 is capped to 05-18..06-07: records exactly that, succeeds — A's promise is out of
    // reach and stays exactly as it was; B's own promise is settled.
    await recordPendingWindow(db, 'B', '2026-05-18', '2026-06-07', AT);
    await settlePendingWindows(db, { from: '2026-05-18', to: '2026-06-07' }, AT);
    expect(await spans(db)).toEqual(['A:2026-04-01..2026-04-10']);
    // C on 06-08 is capped to 05-19..06-08, records exactly that, and dies after recording.
    await recordPendingWindow(db, 'C', '2026-05-19', '2026-06-08', AT);
    expect(await spans(db)).toEqual(['A:2026-04-01..2026-04-10', 'C:2026-05-19..2026-06-08']);
    // D on 06-09 is capped to 05-20..06-09 and succeeds: C's promise shrinks to the one day D did
    // not cover, A's stays. Nothing ever widened to include 04-11..05-18 (already covered by B).
    await recordPendingWindow(db, 'D', '2026-05-20', '2026-06-09', AT);
    await settlePendingWindows(db, { from: '2026-05-20', to: '2026-06-09' }, AT);
    expect(await spans(db)).toEqual(['A:2026-04-01..2026-04-10', 'C:2026-05-19..2026-05-19']);
    // E: an operator's wide trigger (maxWindowDays large) whose coverage spans everything.
    await recordPendingWindow(db, 'E', '2026-03-01', '2026-06-10', AT);
    const result = await settlePendingWindows(db, { from: '2026-03-01', to: '2026-06-10' }, AT);
    expect(result.remaining).toEqual([]);
    expect(await spans(db)).toEqual([]);
  });

  it('settling a promise is atomic: a failed delete leaves it exactly as it was', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = d1FromSqlite(raw);
    await recordPendingWindow(db, 'dead', '2026-05-10', '2026-05-25', AT);
    // The read succeeds; the promise's own batch (DELETE + re-insert of the shrunk rest) is refused
    // by a trigger, so the batch rolls back and the promise is untouched — not deleted, not shrunk.
    raw.exec(
      "CREATE TRIGGER block_delete BEFORE DELETE ON refresh_pending_window BEGIN SELECT RAISE(ABORT, 'nope'); END;",
    );
    await expect(
      settlePendingWindows(db, { from: '2026-05-18', to: '2026-06-07' }, AT),
    ).rejects.toThrow(/nope/);
    expect(await spans(db)).toEqual(['dead:2026-05-10..2026-05-25']);
  });

  it('a refused re-insert of the shrunk remainder rolls the delete back too', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = d1FromSqlite(raw);
    await recordPendingWindow(db, 'dead', '2026-05-10', '2026-05-25', AT);
    // The DELETE succeeds; the INSERT of the shrunk remainder is refused — the whole batch must roll
    // back, or a straddling promise would silently vanish instead of shrinking.
    raw.exec(
      "CREATE TRIGGER block_insert BEFORE INSERT ON refresh_pending_window WHEN NEW.window_to = '2026-05-17' BEGIN SELECT RAISE(ABORT, 'no remainder'); END;",
    );
    await expect(
      settlePendingWindows(db, { from: '2026-05-18', to: '2026-06-07' }, AT),
    ).rejects.toThrow(/no remainder/);
    expect(await spans(db)).toEqual(['dead:2026-05-10..2026-05-25']);
  });

  it('settles promises independently: one refused promise does not undo another', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = d1FromSqlite(raw);
    await recordPendingWindow(db, 'first', '2026-05-01', '2026-05-05', AT); // spanned → deleted
    await recordPendingWindow(db, 'second', '2026-05-10', '2026-05-25', AT); // straddles → shrinks
    // Refuse only the second promise's delete.
    raw.exec(
      "CREATE TRIGGER block_second BEFORE DELETE ON refresh_pending_window WHEN OLD.holder = 'second' BEGIN SELECT RAISE(ABORT, 'second refused'); END;",
    );
    await expect(
      settlePendingWindows(db, { from: '2026-05-01', to: '2026-05-17' }, AT),
    ).rejects.toThrow(/second refused/);
    // the first was settled in its own batch and stays settled; the second is intact for the next run
    expect(await spans(db)).toEqual(['second:2026-05-10..2026-05-25']);
  });
});
