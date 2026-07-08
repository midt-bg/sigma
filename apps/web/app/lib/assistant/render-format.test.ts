import { describe, expect, it } from 'vitest';
import { count, date, money, pct } from '@sigma/shared';
import { entityHref, formatCell } from './render-format';

describe('formatCell', () => {
  it('delegates each numeric/date hint to the site formatter (no format drift)', () => {
    expect(formatCell(1234567, 'money')).toBe(money(1234567));
    expect(formatCell(42, 'number')).toBe(count(42));
    expect(formatCell(0.37, 'percent')).toBe(pct(0.37));
    expect(formatCell('2024-01-15', 'date')).toBe(date('2024-01-15'));
  });

  it('coerces numeric strings before formatting', () => {
    expect(formatCell('1234567', 'money')).toBe(money(1234567));
  });

  it('does not coerce hex/scientific strings (matches strict asNumber — review #80, ultra)', () => {
    // a TEXT value column with "0x10"/"1e3" must not render a value diverging from the cited cell
    expect(formatCell('0x10', 'number')).toBe(count(null));
    expect(formatCell('1e3', 'money')).toBe(money(null));
    expect(formatCell('42', 'number')).toBe(count(42)); // a plain decimal still formats
  });

  it('renders text as-is and absent/blank values as the em-dash', () => {
    expect(formatCell('Министерство на финансите', 'text')).toBe('Министерство на финансите');
    expect(formatCell(null, 'text')).toBe('—');
    expect(formatCell('', 'text')).toBe('—');
    expect(formatCell(null, 'money')).toBe(money(null)); // shared helper's em-dash
  });
});

describe('entityHref', () => {
  it('builds canonical internal hrefs from raw domain ids', () => {
    expect(entityHref('authority', 'auth:000695089')).toBe('/authorities/000695089');
    expect(entityHref('company', 'eik:103267194')).toBe('/companies/103267194');
    expect(entityHref('contract', 'c:abc123')).toBe('/contracts/abc123');
  });

  it('URL-encodes a malformed id so it cannot break out of the href (review #80)', () => {
    const href = entityHref('authority', 'auth:00 6<x>');
    expect(href.startsWith('/authorities/')).toBe(true);
    expect(href).not.toMatch(/[ <>]/); // space / angle brackets are percent-encoded, never literal
  });

  it('also encodes # ? & that encodeURI leaves through (review #80, ultra #13)', () => {
    const href = entityHref('authority', 'auth:1#a?b&c');
    expect(href.startsWith('/authorities/')).toBe(true);
    expect(href).not.toMatch(/[#?&]/); // no fragment/query/param can be injected via a malformed id
  });
});
