import { expect, it, vi } from 'vitest';
import { recordingD1 } from '@sigma/test-support';
import { getDb } from './readonly-d1';

// A blip on one query used to reject the whole loader and render the full-page error boundary. A crawl
// of 220 pages during a weekly declarations run hit it twice, on pages whose loaders had no retry.
// recordingD1 is the double for testing a WRAPPER over D1: it accepts arbitrary SQL and records it.
function flaky(failures: number) {
  let left = failures;
  const tries = { n: 0 };
  const attempt = <T>(value: T): T => {
    tries.n += 1;
    if (left-- > 0) throw new Error('D1_ERROR: network connection lost');
    return value;
  };
  const { db } = recordingD1([
    {
      when: [],
      first: () => attempt({ n: 1 }),
      all: () => attempt([{ n: 1 }]),
      run: () => attempt(undefined),
      raw: () => attempt([[1]]),
      rawColumns: ['n'],
    },
  ]);
  return { db, tries };
}

it('heals a transient fault on every result method, bound or not', async () => {
  const reads: [string, (s: D1PreparedStatement) => Promise<unknown>][] = [
    ['first', (s) => s.first()],
    ['first+column', (s) => s.first('n')],
    ['all', (s) => s.all()],
    ['run', (s) => s.run()],
    ['raw', (s) => s.raw()],
    ['raw+columnNames', (s) => s.raw({ columnNames: true })],
  ];
  for (const [name, read] of reads) {
    const { db, tries } = flaky(2);
    const prepared = getDb({ DB: db }).prepare('SELECT n FROM t WHERE id=?').bind(1);
    await expect(read(prepared), name).resolves.toBeDefined();
    expect(tries.n, name).toBe(3);
  }
});

it('gives up after the bounded attempts and surfaces the real error', async () => {
  const { db, tries } = flaky(99);
  await expect(getDb({ DB: db }).prepare('SELECT 1').all()).rejects.toThrow(
    'D1_ERROR: network connection lost',
  );
  expect(tries.n).toBe(3);
});

// The guard still runs first: a write never reaches the retry, which is what makes re-running safe.
it('refuses a write before any attempt is made', () => {
  const { db, tries } = flaky(0);
  expect(() => getDb({ DB: db }).prepare('DELETE FROM persons')).toThrow();
  expect(tries.n).toBe(0);
});

// A thrown Response is React Router's 404/redirect idiom — intentional control flow, never a transient
// fault — so it must reach the caller on the FIRST throw rather than burn the attempts.
it('passes a thrown Response straight through without retrying', async () => {
  let tries = 0;
  const { db } = recordingD1([
    {
      when: [],
      all: () => {
        tries += 1;
        throw new Response('Not Found', { status: 404 });
      },
    },
  ]);
  await expect(getDb({ DB: db }).prepare('SELECT 1').all()).rejects.toBeInstanceOf(Response);
  expect(tries).toBe(1);
});

// The column names come back ahead of the rows, exactly as D1 returns them.
it('keeps the shape of a raw read with column names', async () => {
  const { db } = flaky(0);
  expect(await getDb({ DB: db }).prepare('SELECT n FROM t').raw({ columnNames: true })).toEqual([
    ['n'],
    [1],
  ]);
});

// Workers can reject with something that is not an Error. The warning must still name it rather than
// read „undefined", and the retry must go on regardless.
it('logs a non-Error rejection as it is and keeps retrying', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let left = 1;
  const { db } = recordingD1([
    {
      when: [],
      all: () => {
        if (left-- > 0) throw 'D1_ERROR: dropped';
        return [{ n: 1 }];
      },
    },
  ]);
  await expect(getDb({ DB: db }).prepare('SELECT 1').all()).resolves.toBeDefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/3'), 'D1_ERROR: dropped');
  warn.mockRestore();
});
