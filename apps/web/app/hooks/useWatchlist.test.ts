import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWatchlist } from './useWatchlist';

// Mock React to bypass the hook render restrictions
vi.mock('react', () => ({
  useSyncExternalStore: (subscribe: any, getSnapshot: any) => getSnapshot(),
}));

// Mock global window and localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
})();
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  },
  writable: true,
});

describe('useWatchlist', () => {
  beforeEach(() => {
    localStorage.clear();
    const { clearAll } = useWatchlist();
    clearAll(); // this clears both localStorage and the memoryCache
  });

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem('sigma-watchlist', '{ "invalid": "json" }'); // valid JSON but not an array
    const { items } = useWatchlist();
    expect(items).toEqual([]); // Should fallback to empty array
  });

  it('handles completely malformed JSON gracefully', () => {
    localStorage.setItem('sigma-watchlist', 'invalid-json');
    const { items } = useWatchlist();
    expect(items).toEqual([]); // Should fallback to empty array
  });

  it('toggles items correctly (idempotency)', () => {
    const { toggleItem, isSaved } = useWatchlist();
    const item = {
      kind: 'contract' as const,
      id: '123',
      title: 'Test',
      subtitle: 'Sub',
      href: '/',
    };

    // Initially not saved
    expect(isSaved('contract', '123')).toBe(false);

    // Toggle on
    toggleItem(item);

    // We need to get a fresh reference because `items` from the first call is a stale closure in our mock
    expect(useWatchlist().isSaved('contract', '123')).toBe(true);
    expect(useWatchlist().items).toHaveLength(1);

    // Toggle off
    useWatchlist().toggleItem(item);
    expect(useWatchlist().isSaved('contract', '123')).toBe(false);
    expect(useWatchlist().items).toHaveLength(0);
  });
});
