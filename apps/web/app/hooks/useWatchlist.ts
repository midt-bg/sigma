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

function getWatchlist(): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  if (memoryCache) return memoryCache;
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    memoryCache = data ? JSON.parse(data) : [];
  } catch {
    memoryCache = [];
  }
  return memoryCache!;
}

function setWatchlist(list: WatchlistItem[]) {
  if (typeof window === 'undefined') return;
  memoryCache = list;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      memoryCache = null;
      listener();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export function useWatchlist() {
  // SSR snapshot must match client initial snapshot, or we accept the mismatch.
  // We return [] during SSR. During hydration on client it might return [items].
  // React 18+ useSyncExternalStore handles this gracefully, but we must be careful.
  const items = useSyncExternalStore(subscribe, getWatchlist, () => []);

  const isSaved = (id: string) => items.some((i) => i.id === id);

  const toggleItem = (item: Omit<WatchlistItem, 'addedAt'>) => {
    const list = getWatchlist();
    if (list.some((i) => i.id === item.id)) {
      setWatchlist(list.filter((i) => i.id !== item.id));
    } else {
      setWatchlist([{ ...item, addedAt: new Date().toISOString() }, ...list]);
    }
  };

  const clearAll = () => setWatchlist([]);

  const removeItem = (id: string) => {
    setWatchlist(getWatchlist().filter((i) => i.id !== id));
  };

  return { items, isSaved, toggleItem, clearAll, removeItem };
}
