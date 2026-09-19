import { describe, expect, it } from 'vitest';
import { InMemoryCache, InMemoryCacheStorage, resetPolyfillCacheForTesting } from './polyfills';

describe('InMemoryCacheStorage.default — singleton invariant', () => {
  it('returns the same instance on every access (so afterEach clear() reaches the cache used by app.fetch)', () => {
    // workers/app.ts reads `caches.default` at module-init time and uses that exact reference
    // for every `edgeCache.match(key)` / `edgeCache.put(key, res)` call. If `.default` returned
    // a NEW instance per access, put() and match() would talk to different Maps and HIT-on-
    // first-request semantics would silently regress. The `afterEach` hook in polyfills.ts
    // also relies on `clear()` reaching the same instance — a detached fresh instance would
    // survive `clear()` and leak state between tests.
    const storage = new InMemoryCacheStorage();
    const a = storage.default;
    const b = storage.default;
    expect(a).toBe(b);
  });

  it('clear() actually empties the .default cache (not a detached fresh instance)', async () => {
    // If a future regression returned a fresh InMemoryCache per access (the trap the PR #177
    // review T-STATIC-DEFAULT flagged), `put` here would write to one instance and `clear`
    // would iterate a different Map — the put entry would survive and pollute the next test.
    const storage = new InMemoryCacheStorage();
    const cache = storage.default;
    const req = new Request('http://example.test/p');
    const res = new Response('hello', { status: 200 });
    await cache.put(req, res);
    expect((await cache.match(req))?.status).toBe(200);
    storage.clear();
    expect(await cache.match(req)).toBeUndefined();
  });
});

describe('InMemoryCache — no stale static default', () => {
  it('does not expose a static get default() (it would return a detached InMemoryCache outside byName)', () => {
    // PR #177 review T-STATIC-DEFAULT: `static get default()` returned `new InMemoryCache()`
    // per access — outside `byName`, so `afterEach` clear() never reached it. Removed in
    // the same commit; this test is the tripwire so a future refactor doesn't reintroduce
    // the trap.
    const proto = InMemoryCache as unknown as { default?: unknown };
    // The INSTANCE getter must still exist (used via `this.default` inside InMemoryCacheStorage).
    const inst = new InMemoryCache();
    expect(typeof inst.default).toBe('object');
    expect(inst.default).toBe(inst);
    // The STATIC getter must NOT exist (would silently leak a detached cache outside byName).
    expect(proto.default).toBeUndefined();
  });
});

describe('resetPolyfillCacheForTesting — exposes the polyfill reset entry point', () => {
  it('clears the globalThis.caches so a fresh test starts with an empty storage', async () => {
    // The setup.ts harness invokes this between tests that need isolation from rate-limit
    // state. The exported helper must (a) actually clear the storage Map and (b) be safe to
    // call when caches is already undefined.
    resetPolyfillCacheForTesting();
    const caches = (
      globalThis as unknown as {
        caches?: {
          default: {
            put: (k: Request, v: Response) => Promise<void>;
            match: (k: Request) => Promise<Response | undefined>;
          };
        };
      }
    ).caches;
    if (caches) {
      await caches.default.put(new Request('http://example.test/x'), new Response('1'));
      const before = await caches.default.match(new Request('http://example.test/x'));
      expect(before?.status).toBe(200);
      resetPolyfillCacheForTesting();
      const after = await caches.default.match(new Request('http://example.test/x'));
      expect(after).toBeUndefined();
    }
  });
});
