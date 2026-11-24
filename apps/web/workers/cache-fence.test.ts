import { afterEach, expect, it, vi } from 'vitest';
import { cacheReadToken, trackWrite, withdraw } from './cache-fence';
import { MAX_SERVING_MS } from './edge-entry';

afterEach(() => vi.useRealTimers());

it('rejects prior snapshots after a successful delete and permits fresh reads', () => {
  const url = 'https://example.invalid/persons/test-fixture';
  const before = cacheReadToken(url)!;
  const cleaned = withdraw(url);
  expect(cacheReadToken(url)).toBeNull();
  cleaned();
  expect(before.unchanged()).toBe(false);
  before.release();
  expect(cacheReadToken(url)?.unchanged()).toBe(true);
});

it('keeps a failed withdrawal blocked through the maximum serving TTL', () => {
  vi.useFakeTimers();
  const url = 'https://example.invalid/persons/test%2Ffixture';
  const other = url.replace('%2F', '/');
  withdraw(url);
  vi.advanceTimersByTime(MAX_SERVING_MS - 1);
  expect(cacheReadToken(url)).toBeNull();
  expect(cacheReadToken(other)?.unchanged()).toBe(true);
  expect(trackWrite(url, Date.now() + 1000)).toBeNull();
  vi.advanceTimersByTime(1);
  expect(cacheReadToken(url)?.unchanged()).toBe(true);
});

it('holds an outstanding put fence through its own deadline and retains newer writes', () => {
  vi.useFakeTimers();
  const url = 'https://example.invalid/persons/test-write';
  const release = trackWrite(url, Date.now() + 1000)!;
  expect(cacheReadToken(url)).toBeNull();
  vi.advanceTimersByTime(1000);
  expect(cacheReadToken(url)?.unchanged()).toBe(true);
  const next = trackWrite(url, Date.now() + 1000)!;
  release();
  expect(cacheReadToken(url)).toBeNull();
  next();
  expect(cacheReadToken(url)?.unchanged()).toBe(true);
});

it('quarantines the cache when a withdrawal arrives with all fence records occupied', async () => {
  vi.useFakeTimers();
  // Start with a fresh isolate so earlier tests' live readers cannot affect its capacity.
  vi.resetModules();
  const { cacheReadToken, trackWrite, withdraw } = await import('./cache-fence');
  const capacity = 8_192;
  const key = (n: number) => `https://example.invalid/contracts/fixture-${n}`;
  const readers = Array.from({ length: capacity }, (_, i) => cacheReadToken(key(i)));
  expect(readers.every((reader) => reader != null)).toBe(true);

  const untracked = key(capacity);
  expect(cacheReadToken(untracked)).toBeNull();
  expect(trackWrite(untracked, Date.now() + 1_000)).toBeNull();
  const captured = readers[0]!;
  expect(captured.unchanged()).toBe(true);

  const finishWithdrawal = withdraw(untracked);
  finishWithdrawal();
  expect(captured.unchanged()).toBe(false);
  expect(cacheReadToken(key(0))).toBeNull();
  vi.advanceTimersByTime(MAX_SERVING_MS - 1);
  expect(cacheReadToken(untracked)).toBeNull();
  vi.advanceTimersByTime(1);
  expect(captured.unchanged()).toBe(false);
  const fresh = cacheReadToken(untracked);
  expect(fresh?.unchanged()).toBe(true);

  fresh?.release();
  for (const reader of readers) reader?.release();
});
