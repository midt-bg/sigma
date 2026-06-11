import { describe, expect, it } from 'vitest';
import { optionsResponse, redirectCleartextHttp, setAllowHeader } from './http';

describe('redirectCleartextHttp', () => {
  it('redirects HTTP to HTTPS in production', () => {
    const response = redirectCleartextHttp(new Request('http://local/companies?q=test'), true);

    expect(response?.status).toBe(301);
    expect(response?.headers.get('Location')).toBe('https://local/companies?q=test');
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('does not redirect HTTP in development', () => {
    expect(redirectCleartextHttp(new Request('http://local/'), false)).toBeNull();
  });
});

describe('optionsResponse', () => {
  it('returns a hardened 204 with the method contract', async () => {
    const response = optionsResponse(false);

    expect(response.status).toBe(204);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe('');
  });
});

describe('setAllowHeader', () => {
  it('sets Allow only on 405 responses', () => {
    const methodNotAllowed = new Headers();
    const ok = new Headers();

    setAllowHeader(methodNotAllowed, 405);
    setAllowHeader(ok, 200);

    expect(methodNotAllowed.get('Allow')).toBe('GET, HEAD');
    expect(ok.has('Allow')).toBe(false);
  });
});
