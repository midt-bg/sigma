import { useSyncExternalStore } from 'react';

export type WatchlistItemKind = 'contract' | 'company' | 'authority';

export interface WatchlistItem {
  id: string;
  kind: WatchlistItemKind;
  title: string;
  subtitle: string;
  href: string;
  addedAt: string;
}

const STORAGE_KEY = 'sigma-watchlist';

let memoryCache: WatchlistItem[] | null = null;
const listeners = new Set<() => void>();

const EMPTY: WatchlistItem[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      memoryCache = null;
      listeners.forEach((l) => l());
    }
  });
}

function getWatchlist(): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  if (memoryCache) return memoryCache;
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const parsed = data ? JSON.parse(data) : [];
    memoryCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    memoryCache = [];
  }
  return memoryCache!;
}

function setWatchlist(list: WatchlistItem[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    memoryCache = list;
    listeners.forEach((l) => l());
  } catch (err) {
    console.warn('Watchlist storage quota exceeded or unavailable', err);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWatchlist() {
  // SSR snapshot must match client initial snapshot, or we accept the mismatch.
  // We return [] during SSR. During hydration on client it might return [items].
  // React 18+ useSyncExternalStore handles this gracefully, but we must be careful.
  const items = useSyncExternalStore(subscribe, getWatchlist, () => EMPTY);

  const isSaved = (kind: WatchlistItemKind, id: string) => items.some((i) => i.kind === kind && i.id === id);

  const toggleItem = (item: Omit<WatchlistItem, 'addedAt'>) => {
    const list = getWatchlist();
    if (list.some((i) => i.kind === item.kind && i.id === item.id)) {
      setWatchlist(list.filter((i) => !(i.kind === item.kind && i.id === item.id)));
    } else {
      setWatchlist([{ ...item, addedAt: new Date().toISOString() }, ...list]);
    }
  };

  const clearAll = () => setWatchlist([]);

  const removeItem = (kind: WatchlistItemKind, id: string) => {
    setWatchlist(getWatchlist().filter((i) => !(i.kind === kind && i.id === id)));
  };

  return { items, isSaved, toggleItem, clearAll, removeItem };
}
