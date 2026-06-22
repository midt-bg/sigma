import { describe, expect, it } from 'vitest';
import { cspNonce, hashTrustedInlineScripts } from './csp';

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

describe('cspNonce', () => {
  it('extracts the nonce from a nonce-based CSP header', () => {
    const headers = new Headers({
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-abc123'",
    });
    expect(cspNonce(headers)).toBe('abc123');
  });

  it('returns null when no CSP / no nonce is present', () => {
    expect(cspNonce(new Headers())).toBeNull();
    expect(
      cspNonce(new Headers({ 'Content-Security-Policy': "script-src 'self' 'sha256-x'" })),
    ).toBeNull();
  });
});

describe('hashTrustedInlineScripts', () => {
  it('hashes inline scripts that carry the per-request nonce', async () => {
    const html = `<html><body><script nonce="n0nce">window.__data = 1;</script></body></html>`;
    expect(await hashTrustedInlineScripts(html, 'n0nce')).toEqual([
      await sha256('window.__data = 1;'),
    ]);
  });

  it('excludes inline scripts without the nonce (the self-authorization guard)', async () => {
    const html = [
      `<script nonce="n0nce">trusted();</script>`,
      `<script>injected()</script>`,
      `<script nonce="wrong">stale_nonce()</script>`,
    ].join('');
    expect(await hashTrustedInlineScripts(html, 'n0nce')).toEqual([await sha256('trusted();')]);
  });

  it('ignores external scripts and accepts single-quoted nonce attributes', async () => {
    const html = [
      `<script src="/assets/app.js" nonce="n0nce"></script>`,
      `<script nonce='n0nce'>boot();</script>`,
    ].join('');
    expect(await hashTrustedInlineScripts(html, 'n0nce')).toEqual([await sha256('boot();')]);
  });

  it('deduplicates identical trusted script bodies', async () => {
    const html = `<script nonce="n">a()</script><script nonce="n">a()</script>`;
    expect(await hashTrustedInlineScripts(html, 'n')).toEqual([await sha256('a()')]);
  });

  it('returns no hashes when the body has no nonce-bearing scripts', async () => {
    expect(await hashTrustedInlineScripts('<p>no scripts</p>', 'n')).toEqual([]);
  });
});
