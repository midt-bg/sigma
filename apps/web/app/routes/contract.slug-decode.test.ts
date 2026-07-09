import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router';
import { contractIdFromSlug, contractSlug } from '@sigma/db';
import routeConfig from '../routes';

// End-to-end proof for the AOP-slug encoding fix (#213 / review #221): close the loop the unit
// tests in `identity.test.ts` can only simulate. Those assert `contractIdFromSlug(decodeURIComponent
// (slug))` round-trips — but the hand-rolled `decodeURIComponent` is NOT how the running app decodes
// the path. On Cloudflare Workers the server request handler matches the URL through React Router's
// real route table, and RR's param decoding is subtler than a single `decodeURIComponent`: it runs
// `decodePath` (per-segment `decodeURIComponent`, re-escaping any literal "/" back to "%2F") and then
// replaces the surviving "%2F" with "/". This test drives that ACTUAL pipeline via `matchRoutes` — the
// same matcher the server build uses — so we prove `params.id` arrives correctly decoded rather than
// trusting a stand-in.
//
// Not covered here (no unit-test surface): an edge/CDN layer normalising or rejecting "%2F" in the
// path segment *before* the request reaches the worker. That is infrastructure behaviour; it must be
// checked with a real HTTP request against a deployed preview, not in-process.

// Use the app's real route pattern so this test breaks if `/contracts/:id` is ever renamed.
const contractPath = (routeConfig as Array<{ path?: string }>).find(
  (r) => r.path === 'contracts/:id',
)?.path;

// Real-world contract id shapes. Each is a domain id (`c:*`); the value is what the DB stores and what
// `contractIdFromSlug(params.id)` must reconstruct after a full encode → URL → RR-decode trip.
const CASES: Array<{ label: string; id: string }> = [
  // The bug that started it all: АОП number with two "/" in the id.
  {
    label: 'AOP id with "/" and Cyrillic',
    id: 'c:e:00797-2020-0039:93-ОП20-42/22/:5:eik:102130456:1',
  },
  // Literal "%" in the source id — contractSlug escapes it to "%25" so RR won't see a malformed escape.
  { label: 'literal "%" in id', id: 'c:e:UNP:50%ADVANCE:_:eik:123456789:1' },
  // "?" and "#" are URL-structural; they must survive the round trip too.
  { label: '"?" and "#" in id', id: 'c:e:UNP:CONTRACT?v=2#note:_:eik:123456789:1' },
  // Plain rowid — no encoding needed; must still match.
  { label: 'plain rowid', id: 'c:52' },
];

describe('contract slug decodes end-to-end through React Router matching', () => {
  it('uses the real /contracts/:id route pattern from routes.ts', () => {
    expect(contractPath).toBe('contracts/:id');
  });

  for (const { label, id } of CASES) {
    it(`round-trips ${label} from an encoded URL back to the domain id`, () => {
      const url = `/contracts/${contractSlug(id)}`;
      const matches = matchRoutes([{ path: 'contracts/:id', id: 'contract' }], url);

      // The URL React Router receives is the encoded one — matching must succeed on it.
      expect(matches).not.toBeNull();
      const decodedId = contractIdFromSlug(matches![0].params.id!);
      expect(decodedId).toBe(id);
    });
  }

  it('the AOP url is genuinely percent-encoded (guards the test itself)', () => {
    const url = `/contracts/${contractSlug('c:e:00797-2020-0039:93-ОП20-42/22/:5:eik:102130456:1')}`;
    expect(url).toContain('%2F');
    expect(url).not.toContain('42/22');
  });
});
