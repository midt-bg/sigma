import { describe, expect, it } from 'vitest';
import { isSafeHref, sanitizeLinkHref } from './sanitize-markdown';

describe('isSafeHref', () => {
  it('allows http: and https:', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com/path?q=1')).toBe(true);
    expect(isSafeHref('https://sigma.bg/companies/000695089')).toBe(true);
  });

  it('refuses javascript:', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('javascript:void(0)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false); // leading whitespace
  });

  it('refuses data:', () => {
    expect(isSafeHref('data:text/html,<h1>xss</h1>')).toBe(false);
    expect(isSafeHref('data:image/svg+xml,<svg/>')).toBe(false);
  });

  it('refuses file: and blob:', () => {
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
    expect(isSafeHref('blob:https://example.com/uuid')).toBe(false);
  });

  it('refuses vbscript:', () => {
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('allows relative paths (no scheme)', () => {
    expect(isSafeHref('/authorities/000695089')).toBe(true);
    expect(isSafeHref('/reports/:id')).toBe(true); // colon is in a path segment, not a scheme
    expect(isSafeHref('./report')).toBe(true);
    expect(isSafeHref('#section')).toBe(true);
    expect(isSafeHref('?q=search')).toBe(true);
  });

  it('refuses empty and whitespace-only strings', () => {
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
  });

  it('refuses an invalid URL that has a colon', () => {
    // Not a valid URL and no recognised safe scheme → refuse.
    expect(isSafeHref('javascript :')).toBe(false); // space in scheme → URL parse fails → false
  });
});

describe('sanitizeLinkHref', () => {
  it('returns the href unchanged when safe', () => {
    expect(sanitizeLinkHref('https://example.com')).toBe('https://example.com');
    expect(sanitizeLinkHref('/authorities/123')).toBe('/authorities/123');
  });

  it('returns null for unsafe hrefs', () => {
    expect(sanitizeLinkHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkHref('data:text/html,xss')).toBeNull();
    expect(sanitizeLinkHref('file:///etc/passwd')).toBeNull();
  });
});
