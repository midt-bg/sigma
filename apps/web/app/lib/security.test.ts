import { describe, expect, it } from 'vitest';
import {
  PRIVACY_MASK_APPLIED,
  PRIVACY_MASK_MARKER,
  applyPrivacyMaskHeaders,
  baseSecurityHeaders,
  markPrivacyMaskApplied,
  nonceLessSecurityHeaders,
  securityHeaders,
} from './security';

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

describe('privacy mask headers', () => {
  it('sets the marker to PRIVACY_MASK_APPLIED on the provided Headers after markPrivacyMaskApplied', () => {
    const headers = new Headers();
    markPrivacyMaskApplied(headers);
    expect(headers.get(PRIVACY_MASK_MARKER)).toBe(PRIVACY_MASK_APPLIED);
  });

  it('translates the marker to X-Robots-Tag: noindex and deletes the marker', () => {
    const headers = new Headers();
    markPrivacyMaskApplied(headers);
    applyPrivacyMaskHeaders(headers);
    expect(headers.get('X-Robots-Tag')).toBe('noindex');
    expect(headers.has(PRIVACY_MASK_MARKER)).toBe(false);
  });

  it('adds no X-Robots-Tag and leaves no marker when the marker is absent', () => {
    const headers = new Headers({ 'Cache-Control': 'public, max-age=3600' });
    applyPrivacyMaskHeaders(headers);
    expect(headers.has('X-Robots-Tag')).toBe(false);
    expect(headers.has(PRIVACY_MASK_MARKER)).toBe(false);
    // Untouched headers survive the call.
    expect(headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('is idempotent on a second call — no re-set, no marker, X-Robots-Tag left intact', () => {
    const headers = new Headers();
    markPrivacyMaskApplied(headers);
    applyPrivacyMaskHeaders(headers);
    // Second call: marker is already gone, an existing X-Robots-Tag is left as-is.
    applyPrivacyMaskHeaders(headers);
    expect(headers.get('X-Robots-Tag')).toBe('noindex');
    expect(headers.has(PRIVACY_MASK_MARKER)).toBe(false);
  });

  it('treats PRIVACY_MASK_APPLIED as the literal type — only that exact value triggers the translate', () => {
    // Type-level guard: PRIVACY_MASK_APPLIED is typed `as const`, so this comparison compiles
    // only because the constant is the exported literal. A re-typed string-literal in
    // `markPrivacyMaskApplied` (e.g. 'applied' with whitespace) would no longer satisfy
    // `=== PRIVACY_MASK_APPLIED` and the test would fail.
    expect(PRIVACY_MASK_APPLIED).toBe('applied');

    const headers = new Headers();
    headers.set(PRIVACY_MASK_MARKER, 'something-else');
    applyPrivacyMaskHeaders(headers);
    expect(headers.has('X-Robots-Tag')).toBe(false);
    expect(headers.has(PRIVACY_MASK_MARKER)).toBe(false);
  });
});
