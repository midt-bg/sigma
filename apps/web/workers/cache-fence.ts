import { MAX_SERVING_MS } from './edge-entry';

// Per-isolate metadata only. Keys retain the encoded path, accepted query and namespace.
const MAX_KEYS = 8192;
type Deadline = { expires: number };
type Fence = {
  version: number;
  readers: number;
  lastRead: number;
  write?: Deadline;
  withdrawal?: Deadline;
};
const fences = new Map<string, Fence>();
let nextSweep = 0;
let pausedUntil = 0;

function fenceFor(key: string, now: number): Fence | undefined {
  if (now >= nextSweep) {
    nextSweep = now + 10_000;
    for (const [url, fence] of fences) {
      if (fence.write && fence.write.expires <= now) delete fence.write;
      if (fence.withdrawal && fence.withdrawal.expires <= now) delete fence.withdrawal;
      // A canceled invocation may never release its token. A late reader from a retired
      // record will fail the identity check even if its lookup eventually completes.
      if (!fence.write && !fence.withdrawal && now - fence.lastRead >= 60_000) fences.delete(url);
    }
  }
  const existing = fences.get(key);
  if (existing) return existing;
  if (fences.size >= MAX_KEYS) return undefined;
  const fence = { version: 0, readers: 0, lastRead: now };
  fences.set(key, fence);
  return fence;
}

function blocked(fence: Fence | undefined, now: number): boolean {
  return now < Math.max(pausedUntil, fence?.write?.expires ?? 0, fence?.withdrawal?.expires ?? 0);
}

function forgetIfIdle(key: string, fence: Fence): void {
  if (!fence.readers && !fence.write && !fence.withdrawal && fences.get(key) === fence)
    fences.delete(key);
}

export function cacheReadToken(key: string) {
  const now = Date.now();
  if (blocked(fences.get(key), now)) return null;
  const fence = fenceFor(key, now);
  if (!fence) return null;
  fence.lastRead = now;
  fence.readers++;
  const version = fence.version;
  const pause = pausedUntil;
  return {
    unchanged: () =>
      pausedUntil === pause &&
      fences.get(key) === fence &&
      fence.version === version &&
      !blocked(fence, Date.now()),
    release: () => {
      fence.readers--;
      forgetIfIdle(key, fence);
    },
  };
}

export function trackWrite(key: string, expires: number): (() => void) | null {
  const now = Date.now();
  if (expires <= now || blocked(fences.get(key), now)) return null;
  const fence = fenceFor(key, now);
  if (!fence) return null;
  const write = { expires };
  fence.version++;
  fence.write = write;
  return () => {
    if (fence.write === write) delete fence.write;
    forgetIfIdle(key, fence);
  };
}

export function withdraw(key: string): () => void {
  const now = Date.now();
  const expires = now + MAX_SERVING_MS;
  const fence = fenceFor(key, now);
  if (!fence) {
    // Capacity pressure can reduce the hit rate. Evicting a live revocation could expose data.
    pausedUntil = expires;
    return () => {};
  }
  const withdrawal = { expires };
  fence.version++;
  fence.withdrawal = withdrawal;
  return () => {
    // The version survives successful deletion for as long as a reader holds this record.
    if (fence.withdrawal === withdrawal) delete fence.withdrawal;
    forgetIfIdle(key, fence);
  };
}
