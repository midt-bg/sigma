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

describe('isSafeHref — adversarial (public XSS surface)', () => {
  it('refuses protocol-relative URLs that resolve to an external origin', () => {
    // `//host` and `\\host` are NOT relative paths — a browser loads them from another origin. The
    // explicit `^[/\\]{2}` reject is the only guard; without it the scheme check below is bypassed.
    expect(isSafeHref('//evil.com/x')).toBe(false);
    expect(isSafeHref('\\\\evil.com\\x')).toBe(false);
    expect(isSafeHref('/\\evil.com')).toBe(false); // mixed slash/backslash still parses as //host
  });

  it('refuses a scheme split by tab/newline/control chars (URL-normalised then rejected)', () => {
    // A browser strips in-scheme tabs/newlines before dispatching an href, so `java<TAB>script:` runs
    // as javascript:. The WHATWG URL parser normalises the same way, so these land as javascript: and
    // are rejected — the string-level scheme scan alone would miss them.
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('javascript:alert(1)')).toBe(false); // C0 control prefix
  });

  it('refuses uppercased/mixed-case dangerous schemes', () => {
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('VBScript:msgbox(1)')).toBe(false);
  });

  it('treats a colon after the first path separator as a relative path, not a scheme', () => {
    // `a/foo:bar` — the `/` precedes the `:`, so the whole string is a relative path a browser resolves
    // against the origin (never a scheme). Must stay allowed so real paths with colons are not blocked.
    expect(isSafeHref('a/foo:bar')).toBe(true);
    expect(isSafeHref('path?x:y')).toBe(true);
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
