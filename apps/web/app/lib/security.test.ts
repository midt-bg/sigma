import { describe, expect, it } from 'vitest';
import { baseSecurityHeaders, nonceLessSecurityHeaders, securityHeaders } from './security';

describe('securityHeaders CSP', () => {
  it('emits a strict nonce script-src and the documented style-src', () => {
    const csp = securityHeaders('test-nonce', true).get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce'");
    // Regression guard for the deliberate 'unsafe-inline' on style-src: update this assertion only
    // when the remaining inline style attributes are removed and the directive is truly tightened.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('uses script hashes (not a nonce) for the edge-cached variant', () => {
    const csp =
      nonceLessSecurityHeaders(["'sha256-abc123'"], true).get('Content-Security-Policy') ?? '';
    expect(csp).toContain("script-src 'self' 'sha256-abc123'");
    expect(csp).not.toContain('nonce-');
  });

  it('omits the CSP outside production but keeps the base hardening headers', () => {
    const dev = securityHeaders('n', false);
    expect(dev.get('Content-Security-Policy')).toBeNull();
    expect(dev.get('X-Content-Type-Options')).toBe('nosniff');
    expect(baseSecurityHeaders(true).get('Strict-Transport-Security')).toContain('max-age=');
  });
});
