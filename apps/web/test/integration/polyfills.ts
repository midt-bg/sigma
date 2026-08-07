// Integration harness — installs workerd-style globals that vitest's `environment: 'node'`
// does not provide. The polyfills must be installed BEFORE any code that reads them is
// evaluated (vitest setupFiles run in declaration order before any test module is loaded).
//
// `globalThis.caches` is read at workers/app.ts:29 module-init time. The polyfill is a
// minimal in-memory CacheStorage — sufficient for the routes we exercise. It does NOT
// roundtrip the same as the workerd isolate cache (E-P1T1-010): put/match across calls
// in one Node process is in-memory but does not time out under the workerd semantics.
// The integration tests assert first-request shapes only, not HIT-on-second.

import { afterEach } from 'vitest';

class InMemoryCache {
  private map = new Map<string, Response>();

  async match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === 'string' ? req : req.url;
    return this.map.get(key)?.clone();
  }
  async put(req: Request | string, res: Response): Promise<void> {
    const key = typeof req === 'string' ? req : req.url;
    this.map.set(key, res.clone());
  }
  async delete(req: Request | string): Promise<boolean> {
    const key = typeof req === 'string' ? req : req.url;
    return this.map.delete(key);
  }
  async matchAll(): Promise<Response[]> {
    return Array.from(this.map.values(), (res) => res.clone());
  }
  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
  get default(): InMemoryCache {
    return this;
  }
  static get default(): InMemoryCache {
    return new InMemoryCache();
  }
  clear(): void {
    this.map.clear();
  }
}

class InMemoryCacheStorage {
  private byName = new Map<string, InMemoryCache>();

  async open(name: string): Promise<InMemoryCache> {
    let c = this.byName.get(name);
    if (!c) {
      c = new InMemoryCache();
      this.byName.set(name, c);
    }
    return c;
  }
  get default(): InMemoryCache {
    let c = this.byName.get('default');
    if (!c) {
      c = new InMemoryCache();
      this.byName.set('default', c);
    }
    return c;
  }
  async match(req: Request | string, _opts?: unknown): Promise<Response | undefined> {
    return this.default.match(req);
  }
  async has(name: string): Promise<boolean> {
    return this.byName.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.byName.delete(name);
  }
  async keys(): Promise<string[]> {
    return Array.from(this.byName.keys());
  }
  clear(): void {
    for (const cache of this.byName.values()) cache.clear();
    this.byName.clear();
  }
}

if (typeof (globalThis as unknown as { caches?: unknown }).caches === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).caches = new InMemoryCacheStorage();
}

afterEach(() => {
  const cacheStorage = (globalThis as unknown as { caches?: { clear?: () => void } }).caches;
  cacheStorage?.clear?.();
});
