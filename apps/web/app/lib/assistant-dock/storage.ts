// Client-side persistence for the chat dock (spec §5: the server is stateless; the transcript lives in
// the browser). Stores the message history + the collapsed flag in localStorage, guarded so it degrades
// to an in-memory session on the server (SSR) or when storage is unavailable/blocked.
//
// History is trimmed to bounds a little tighter than the server's caps (256 KB / 24 messages in
// assistant.chat.tsx) so every POST — current history plus the new turn — stays under them. Messages are
// stored as-is (whole JSON), so any future server-signed fields round-trip untouched (spec §9.3).

import type { UIMessage } from 'ai';
import { devWarn } from './dev-warn';

export const TRANSCRIPT_KEY = 'sigma.assistant.transcript';
export const COLLAPSED_KEY = 'sigma.assistant.collapsed';
export const REPORTS_INDEX_KEY = 'sigma.reports.index';

// POST cap: the server keeps only the last 24 messages (assistant.chat.tsx → MAX_MESSAGES); mirror it so
// we never POST more than it will use. Applied to the wire copy in useAssistantChat, after condensation.
export const MAX_MESSAGES = 24;

// Storage caps: deliberately LARGER than the POST caps. The persisted transcript is the local source of
// truth the recap is condensed from (condense.ts), so old turns must survive here even though only a
// condensed copy goes over the wire. Bounded well under the ~5 MB same-origin localStorage quota —
// report tool-parts are heavy and stay in the persisted copy.
export const STORAGE_MAX_MESSAGES = 60;
export const STORAGE_MAX_BYTES = 1024 * 1024; // 1 MB

// The server rejects request bodies over 256 KB with 413 (assistant.chat.tsx → MAX_BODY_BYTES). Trim the
// persisted/posted history below that so the existing history PLUS the new turn useChat appends, PLUS the
// JSON envelope, still fits. 56 KB of headroom comfortably covers one more message — even one carrying an
// embedded report. (These caps live only in the server code today; the contract doc should document them.)
const SERVER_BODY_CAP_BYTES = 256 * 1024;
export const MAX_BYTES = SERVER_BODY_CAP_BYTES - 56 * 1024; // 200 KB

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Absent on the server (SSR) and in Workers; accessing it can also throw when a browser blocks storage
// (private mode, sandboxed iframe). Either way, fall back to no storage so callers no-op safely.
const defaultStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Keep the most recent messages within both the count and byte budgets, dropping oldest first. */
export const trimMessages = (
  messages: UIMessage[],
  maxMessages = MAX_MESSAGES,
  maxBytes = MAX_BYTES,
): UIMessage[] => {
  let kept = messages.slice(-maxMessages);
  while (kept.length > 1 && byteLength(JSON.stringify(kept)) > maxBytes) {
    kept = kept.slice(1);
  }
  return kept;
};

// A persisted entry we can safely render: it carries the fields every consumer reads — `id` (the React
// key), `role` (styling), and a `parts` array (AssistantMessage.textOf, report-projection both .map it).
// localStorage is same-origin-writable and survives schema changes across deploys, so a malformed or
// legacy entry would otherwise crash the transcript on first render — drop anything that doesn't match.
const isMessagePart = (part: unknown): boolean =>
  typeof part === 'object' && part !== null && 'type' in part && typeof part.type === 'string';

const isStoredMessage = (value: unknown): value is UIMessage => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('role' in value) || typeof value.role !== 'string') return false;
  // Validate the parts elements too, not just that `parts` is an array: consumers (textOf,
  // report-projection) read `part.type`, so a `parts: [null]` would still crash the transcript.
  return 'parts' in value && Array.isArray(value.parts) && value.parts.every(isMessagePart);
};

export const loadTranscript = (storage = defaultStorage()): UIMessage[] => {
  try {
    const raw = storage?.getItem(TRANSCRIPT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMessage);
  } catch (error) {
    // Non-fatal: corrupt/unreadable storage. Start fresh.
    devWarn('[assistant] could not read stored transcript; starting fresh', error);
    return [];
  }
};

export const saveTranscript = (messages: UIMessage[], storage = defaultStorage()): void => {
  if (!storage) return;
  try {
    storage.setItem(
      TRANSCRIPT_KEY,
      JSON.stringify(trimMessages(messages, STORAGE_MAX_MESSAGES, STORAGE_MAX_BYTES)),
    );
  } catch (error) {
    // Non-fatal: quota exceeded / storage blocked. The chat keeps working in memory.
    devWarn('[assistant] transcript not persisted (storage unavailable)', error);
  }
};

// Clear the transcript key only (collapsed flag survives). Writes '[]' — StorageLike has no removeItem.
export const clearTranscript = (storage = defaultStorage()): void => {
  if (!storage) return;
  try {
    storage.setItem(TRANSCRIPT_KEY, '[]');
  } catch (error) {
    devWarn('[assistant] transcript not cleared (storage unavailable)', error);
  }
};

// null when no preference is stored, so the dock can pick a device-appropriate default (open on desktop,
// collapsed on mobile) instead of forcing open everywhere. A stored '0'/'1' always wins.
export const loadCollapsed = (storage = defaultStorage()): boolean | null => {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY);
    return raw == null ? null : raw === '1';
  } catch (error) {
    // Non-fatal: no readable preference → let the caller choose the default.
    devWarn('[assistant] could not read dock state; using the default', error);
    return null;
  }
};

export const saveCollapsed = (collapsed: boolean, storage = defaultStorage()): void => {
  if (!storage) return;
  try {
    storage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (error) {
    devWarn('[assistant] dock state not persisted (storage unavailable)', error);
  }
};

// Per-browser report index — populated when a report is persisted to R2 and its storedId arrives in the
// dock. The index is the authoritative source for /reports; the server never enumerates the bucket so
// each visitor sees only their own reports (spec §5: "без глобално изброяване").
const MAX_REPORTS_INDEX = 50;

export interface ReportIndexEntry {
  id: string;
  title: string;
  question: string;
  createdAt: string;
  /** Lead statistic for the listing page (e.g. "Общо: 2,6 млн €"). Optional — absent for older entries. */
  leadStat?: string | null;
}

const isReportIndexEntry = (v: unknown): v is ReportIndexEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.title === 'string' &&
    typeof e.question === 'string' &&
    typeof e.createdAt === 'string'
  );
};

export const loadReportIndex = (storage = defaultStorage()): ReportIndexEntry[] => {
  try {
    const raw = storage?.getItem(REPORTS_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReportIndexEntry);
  } catch {
    return [];
  }
};

export const addToReportIndex = (entry: ReportIndexEntry, storage = defaultStorage()): void => {
  if (!storage) return;
  try {
    const existing = loadReportIndex(storage);
    if (existing.some((e) => e.id === entry.id)) return; // deduplicate
    const updated = [entry, ...existing].slice(0, MAX_REPORTS_INDEX);
    storage.setItem(REPORTS_INDEX_KEY, JSON.stringify(updated));
  } catch {
    // Non-fatal: quota exceeded / storage blocked
  }
};
