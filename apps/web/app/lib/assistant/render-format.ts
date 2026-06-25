// Renderer contract (spec §4): "format by hint, not by value" + "links by entity-ref, not URL".
//
// The agent emits raw values + a format hint and entity refs ({kind, id}); the renderer turns them
// into display strings and canonical hrefs HERE, reusing the site's own helpers so reports read
// exactly like native pages (no design/format drift). Pure — reuses @sigma/shared formatters and the
// @sigma/db link builder; unit-testable, no bindings. Consumed by the Phase-2 /reports/:id renderer.

import { count, date, money, pct } from '@sigma/shared';
import { hrefForEntity } from '@sigma/db';
import type { CellFormat, EntityKind } from './report-schema';

function num(v: string | number | null): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a resolved cell by its hint, delegating to the site's shared formatters so units/magnitude
 * labels match the rest of the UI. `money` expects EUR; `percent` expects a 0..1 ratio (site
 * convention). Absent/blank values render as the site's em-dash. (Numbers are server-owned — §9.1.)
 */
export function formatCell(value: string | number | null, format: CellFormat): string {
  switch (format) {
    case 'money':
      return money(num(value));
    case 'number':
      return count(num(value));
    case 'percent':
      return pct(num(value));
    case 'date':
      return date(value == null ? null : String(value));
    case 'text':
    default:
      return value == null || value === '' ? '—' : String(value);
  }
}

/**
 * Canonical internal href for an entity reference. `id` is the raw domain id from a result set
 * (`auth:…`, `eik:…`/`name:…`, `c:…`); reuses @sigma/db so name-keyed bidders slug identically to
 * the rest of the site.
 */
export function entityHref(kind: EntityKind, id: string): string {
  // encodeURI (not encodeURIComponent — keep the path separators) as defence-in-depth: the slug helpers
  // already yield URL-safe segments for well-formed ids. encodeURI leaves `# ? &` though, which would
  // split a malformed id into a fragment/query or inject a param — so encode those three too, bounding a
  // bad id strictly within the path (review #80).
  return encodeURI(hrefForEntity(kind, id)).replace(
    /[#?&]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
