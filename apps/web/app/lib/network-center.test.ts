import { describe, expect, it } from 'vitest';
import { authoritySlug, companySlug } from '@sigma/db';
import type { NetworkData } from '@sigma/api-contract';
import { centerToken, isAdoptableNetwork, parseCenter } from './network-center';

// The re-centre link side (centerToken) and the loader side (parseCenter) MUST agree on the `?center`
// grammar, or re-centring breaks silently (the component lands in `failed` with no error). These tests
// pin that contract and the slug round-trip for every node kind.
describe('centerToken ↔ parseCenter round-trip', () => {
  it('round-trips an authority (ЕИК slug)', () => {
    const id = 'auth:000695089';
    const token = centerToken({ kind: 'authority', slug: authoritySlug(id) });
    expect(token).toBe('a:000695089');
    expect(parseCenter(token)).toEqual({ kind: 'authority', id });
  });

  it('round-trips a company with a valid ЕИК', () => {
    const id = 'eik:131063188';
    const token = centerToken({ kind: 'company', slug: companySlug(id) });
    expect(token).toBe('c:131063188');
    expect(parseCenter(token)).toEqual({ kind: 'company', id });
  });

  it('round-trips a name-keyed company (base64url slug — URL-safe, no stray colon)', () => {
    const id = 'name:ТЕСТ ООД';
    const slug = companySlug(id);
    const token = centerToken({ kind: 'company', slug });
    expect(slug.startsWith('n')).toBe(true);
    // Whole token is URL-safe; the only ':' is the grammar separator (so no encodeURIComponent needed).
    expect(token).toMatch(/^c:n[A-Za-z0-9_-]+$/);
    expect(parseCenter(token)).toEqual({ kind: 'company', id });
  });
});

describe('parseCenter rejects malformed tokens (no silent mis-parse)', () => {
  it.each([null, '', 'x', 'a:', ':abc', 'z:abc', 'c:!!!', 'c:n@@@'])('returns null for %p', (t) => {
    expect(parseCenter(t)).toBeNull();
  });
});

describe('isAdoptableNetwork', () => {
  const center = { id: 'auth:1', kind: 'authority', label: 'C', slug: '1', valueEur: 1, hop: 0 };
  const node = { id: 'eik:2', kind: 'company', label: 'N', slug: '2', valueEur: 1, hop: 1 };
  const net = (center: unknown, nodes: unknown[]) =>
    ({ center, nodes, edges: [] }) as unknown as NetworkData;

  it('rejects null, a missing centre, or a centre-only (<2 node) result', () => {
    expect(isAdoptableNetwork(null)).toBe(false);
    expect(isAdoptableNetwork(net(null, []))).toBe(false);
    expect(isAdoptableNetwork(net(center, [center]))).toBe(false);
  });

  it('accepts a centre with at least one neighbour', () => {
    expect(isAdoptableNetwork(net(center, [center, node]))).toBe(true);
  });
});
