// Renderer contract (spec §4): "format by hint, not by value" + "links by entity-ref, not URL".
//
// The agent emits raw values + a format hint and entity refs ({kind, id}); the renderer turns them
// into display strings and canonical hrefs HERE, reusing the site's own helpers so reports read
// exactly like native pages (no design/format drift). Pure — reuses @sigma/shared formatters and the
// @sigma/db link builder; unit-testable, no bindings. Consumed by the Phase-2 /reports/:id renderer.

import { count, date, money, pct } from '@sigma/shared';
import { hrefForEntity } from '@sigma/db';
// `asNumber` is the SHARED decimal-only coercion (defined in report-schema.ts and used by the binder). A
// previous local copy here had to be kept byte-identical by hand to preserve the §9.1 "rendered value
// equals cited cell" rule; importing the one definition removes that drift risk (review #80, follow-up).
import { asNumber, type CellFormat, type EntityKind } from './report-schema';

/**
 * Format a resolved cell by its hint, delegating to the site's shared formatters so units/magnitude
 * labels match the rest of the UI. `money` expects EUR; `percent` expects a 0..1 ratio (site
 * convention). Absent/blank values render as the site's em-dash. (Numbers are server-owned — §9.1.)
 */
export function formatCell(value: string | number | null, format: CellFormat): string {
  switch (format) {
    case 'money':
      return money(asNumber(value));
    case 'number':
      return count(asNumber(value));
    case 'percent':
      return pct(asNumber(value));
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
  // hrefForEntity yields `/<collection>/<slug>`. The old `encodeURI` kept `/` and `.` intact, so a
  // malicious result-cell id used as a link target (`../../authorities/000695089` — a bidder can register
  // a crafted name, and link ids are NOT sanitized in bindReport) produced a relative-traversal href that
  // the browser resolves to a DIFFERENT entity's page: a mis-citation on a transparency report, where a
  // wrong "official" link is worse than none (review #80, follow-up). Encode the SLUG SEGMENT with
  // encodeURIComponent so any `/` or `..` is confined to one inert path segment; well-formed slugs
  // (digits, base64url) are unchanged, and the `/<collection>/` prefix we build here is trusted.
  const collection =
    kind === 'authority' ? 'authorities' : kind === 'company' ? 'companies' : 'contracts';
  const path = hrefForEntity(kind, id);
  const prefix = `/${collection}/`;
  const slug = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return `${prefix}${encodeURIComponent(slug)}`;
}
