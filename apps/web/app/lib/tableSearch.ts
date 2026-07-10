// Pure decision helpers for the in-table search input (ListControls.TableSearch). The guard logic has
// produced several edge bugs because it lived inline in handlers/effects; extracting it makes the
// decisions unit-testable under the node harness — no DOM/component-test stack needed.

import { hasSearchableTerms } from '@sigma/shared';

/**
 * Whether the field should replace its value with the URL's `q`. Adopt only when they differ AND the
 * field isn't being actively edited (`!focused && settled`): so external navigation (back/forward,
 * links, filter changes) is reflected, without reverting a keystroke the user is mid-typing or
 * clobbering a still-pending debounced submit.
 */
export function shouldAdoptUrlQ({
  urlQ,
  value,
  focused,
  settled,
}: {
  urlQ: string;
  value: string;
  focused: boolean;
  settled: boolean;
}): boolean {
  if (urlQ === value) return false;
  return !focused && settled;
}

/**
 * Whether the settled (debounced) value should be live-submitted. Suppress while an IME composition is
 * in flight — so a Cyrillic word commits whole, not „мо" for „мост" — and when the value already
 * matches the URL (the echo of our own navigation, or a no-op). Trim both sides so trailing whitespace
 * isn't treated as a new query. Also suppress a sub-threshold query (fewer than 2 searchable chars):
 * the backend ignores it and shows the full list anyway, so navigating just writes a useless `?q=` —
 * but clearing the field (empty debounced value) must still submit so the URL drops `q`.
 */
export function shouldSubmitLive({
  composing,
  debounced,
  urlQ,
}: {
  composing: boolean;
  debounced: string;
  urlQ: string;
}): boolean {
  if (composing) return false;
  if (debounced.trim() === urlQ.trim()) return false;
  return hasSearchableTerms(debounced) || debounced.trim() === '';
}

/**
 * The composition flag after a composition-related event. Only `start` arms it; `end`, `cancel`, and
 * `blur` all disarm — so a composition that never fires `compositionend` (compositioncancel, or focus
 * loss mid-IME) can't leave the flag stuck on and mute every later live submit.
 */
export function isComposingAfter(event: 'start' | 'end' | 'cancel' | 'blur'): boolean {
  return event === 'start';
}
