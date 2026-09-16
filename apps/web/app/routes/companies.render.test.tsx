// @vitest-environment jsdom
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { CompanyListItem } from '@sigma/api-contract';
import { getCoverageMeta } from '../lib/coverage';
import { getCompanyFacets, listCompanies } from '@sigma/db';
import { toCompanyListItem } from '@sigma/db';
import { maskedCompanySlug } from '@sigma/db';
import Companies, { headers, loader } from './companies';

vi.mock('@sigma/db', async () => {
  const actual = await vi.importActual<typeof import('@sigma/db')>('@sigma/db');
  return {
    ...actual,
    listCompanies: vi.fn(),
    getCompanyFacets: vi.fn(),
    getDb: (env: unknown) => (env as { DB: unknown }).DB,
  };
});

vi.mock('../lib/coverage', async () => {
  const actual = await vi.importActual<typeof import('../lib/coverage')>('../lib/coverage');
  return {
    ...actual,
    getCoverageMeta: vi.fn(),
    coverageRange: actual.coverageRange,
  };
});

function makeItem(overrides: Partial<CompanyListItem> = {}): CompanyListItem {
  return {
    slug: '103267194',
    name: 'ТЕСТ ООД',
    displayName: 'ТЕСТ ООД',
    kind: 'company',
    isConsortium: false,
    eik: '103267194',
    eikValid: true,
    hasEik: true,
    masked: false,
    ownershipKind: null,
    settlement: 'София',
    sector: null,
    wonEur: 50000,
    contracts: 5,
    authorities: 2,
    ...overrides,
  };
}

function loaderArgs(): Parameters<typeof loader>[0] {
  return {
    request: new Request('http://localhost/companies'),
    params: {},
    context: { cloudflare: { env: { DB: {} as never } } },
  } as unknown as Parameters<typeof loader>[0];
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(listCompanies).mockReset();
  vi.mocked(getCompanyFacets).mockReset();
  vi.mocked(getCoverageMeta).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(Component: ComponentType<any>, loaderData: unknown) {
  const Stub = createRoutesStub([
    {
      path: '/companies',
      Component: () => <Component loaderData={loaderData} />,
      loader: () => loaderData,
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/companies']} />);
  });
}

describe('companies.render — masked sole-trader rows do not render an ЕИК-bearing href (ydimitrof review 2026-08-31, thread on rows.ts:74)', () => {
  it('renders a masked row as <span>, not as a <Link> to /companies/<ЕИК>', async () => {
    const legal = makeItem();
    // NB: this test mocks `listCompanies` with a hand-rolled `CompanyListItem`, NOT the real
    // `toCompanyListItem` mapper. The slug `'121817309'` below models the SHAPE a future caller
    // might pass in (a raw ЕИК) — but in production, the mapper at packages/db/src/queries/rows.ts
    // ALWAYS substitutes the opaque `maskedCompanySlug(bidder_id)` for masked rows
    // (FNV-1a hash, not the bare ЕИК; see identity.test.ts > masked company slug). The
    // production SSR hydration payload therefore carries an opaque token, NOT `121817309`.
    // The end-to-end invariant is re-pinned by the integration test below
    // (it('SSR-emitted loaderData for a masked row uses the opaque mapper slug, not the raw ЕИК')).
    const masked = makeItem({
      slug: '121817309',
      name: 'Частно лице',
      displayName: 'Частно лице',
      eik: null,
      eikValid: false,
      hasEik: false,
      masked: true,
    });
    vi.mocked(listCompanies).mockResolvedValueOnce({
      items: [legal, masked],
      total: 2,
      nextCursor: null,
      prevCursor: null,
    });
    vi.mocked(getCompanyFacets).mockResolvedValueOnce({ sectors: [], kinds: [] } as never);
    vi.mocked(getCoverageMeta).mockResolvedValueOnce({
      asOf: '2025-06-30',
      refreshedAt: '2025-07-01T00:00:00Z',
      coverageEndYear: 2025,
    });

    const result = await loader(loaderArgs());
    // Any masked row forces the loader to return a Response.json wrapper so the .data twin
    // carries the privacy marker (the page itself doesn't need noindex). The wrapped payload
    // is `{ page, facets, coverage }` — unwrap for the component.
    expect(result).toBeInstanceOf(Response);
    const wrapped = (await (result as Response).json()) as { page: { items: CompanyListItem[] } };

    await mount(Companies, wrapped);

    // The legal-entity row must remain a working <Link> to its profile.
    const legalLink = container.querySelector('a[href="/companies/103267194"]');
    expect(legalLink).not.toBeNull();

    // The masked row must NOT link anywhere — the rendered href would otherwise carry the
    // sole trader's ЕИК and defeat the privacy goal. The masked name renders as a <span>.
    const maskedHref = container.querySelector('a[href="/companies/121817309"]');
    expect(maskedHref).toBeNull();
    // The label still renders (the row is visible — it just isn't clickable).
    expect(container.textContent).toContain('Частно лице');
  });

  it('routes the marker to the .data twin only and leaves the HTML headers clean (ydimitrof review 2026-08-31, thread on companies.tsx:61)', async () => {
    const masked = makeItem({
      slug: '121817309',
      name: 'Частно лице',
      displayName: 'Частно лице',
      eik: null,
      eikValid: false,
      hasEik: false,
      masked: true,
    });
    vi.mocked(listCompanies).mockResolvedValueOnce({
      items: [masked],
      total: 1,
      nextCursor: null,
      prevCursor: null,
    });
    vi.mocked(getCompanyFacets).mockResolvedValueOnce({ sectors: [], kinds: [] } as never);
    vi.mocked(getCoverageMeta).mockResolvedValueOnce({
      asOf: '2025-06-30',
      refreshedAt: '2025-07-01T00:00:00Z',
      coverageEndYear: 2025,
    });

    const result = await loader(loaderArgs());

    // The loader marks the .data twin (RRv7 single-fetch) but the route's `headers()` must NOT
    // forward it to the HTML doc — a single masked row on an otherwise indexable leaderboard
    // must not deindex the whole HTML page (the masking is label-only on HTML).
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get('X-Privacy-Mask')).toBe('applied');

    const htmlHeaders = headers({
      loaderHeaders: (result as Response).headers,
      parentHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as unknown as Parameters<typeof headers>[0]);
    expect('X-Privacy-Mask' in htmlHeaders).toBe(false);
    expect(htmlHeaders['Cache-Control']).toContain('s-maxage=');
  });
});

// PR #345 review (ydimitrof 2026-09-03, thread on apps/web/app/routes/companies.tsx:175) — the
// reviewer's concern is that even with `<span>` rendering in place, the loaderData is serialised
// into the SSR hydration payload of the public indexable HTML page; a masked row whose `slug`
// field carried the bare ЕИК would leak the natural-person's identifier into the document source.
// The fix lives in the SHARED mapper: `toCompanyListItem` always substitutes the opaque
// `maskedCompanySlug(bidder_id)` for masked rows (FNV-1a hash, never the bare ЕИК), so the SSR
// payload carries an opaque token. This block pins that invariant end-to-end — going through the
// real mapper, not a hand-rolled `CompanyListItem` — and verifies the rendered document does not
// contain the ЕИК anywhere (no `<a href>`, no inline `slug` value, no `<link>` rel).
describe('companies.render — masked sole-trader rows do not leak the bare ЕИК into the indexable HTML (ydimitrof 2026-09-03, thread on companies.tsx:175)', () => {
  function realMaskedItem(): CompanyListItem {
    // Real mapper path — same shape `listCompanies` would return in production for a sole trader.
    return toCompanyListItem({
      bidder_id: 'eik:121817309',
      name: 'НИКОЛАЙ КИРОВ',
      kind: 'company',
      ownership_kind: null,
      eik: '121817309',
      eik_valid: 1,
      settlement: 'София',
      won_eur: 50000,
      contracts: 5,
      authorities: 2,
      primary_sector: null,
      eu_eur: 0,
      first_date: '2024-01-01',
      last_date: '2025-12-31',
      legal_form: 'ЕТ',
    });
  }

  it('toCompanyListItem masks the slug via the opaque mapper (no bare ЕИК in the field)', () => {
    const item = realMaskedItem();
    expect(item.masked).toBe(true);
    expect(item.eik).toBeNull();
    // The slug field must be the opaque token, NOT the bare ЕИК. This is what gets serialised
    // into the SSR hydration payload by RRv7 — if it were `121817309`, the natural-person's ЕИК
    // would land in the indexable document source (ydimitrof 2026-09-03).
    expect(item.slug).not.toBe('121817309');
    expect(item.slug).not.toContain('121817309');
    // The opaque slug is deterministic, opaque (FNV-1a), and non-round-trippable.
    expect(item.slug).toBe(maskedCompanySlug('eik:121817309'));
  });

  it('SSR-emitted loaderData for a masked row uses the opaque mapper slug, not the raw ЕИК', async () => {
    const item = realMaskedItem();
    const legal = makeItem();
    vi.mocked(listCompanies).mockResolvedValueOnce({
      items: [legal, item],
      total: 2,
      nextCursor: null,
      prevCursor: null,
    });
    vi.mocked(getCompanyFacets).mockResolvedValueOnce({ sectors: [], kinds: [] } as never);
    vi.mocked(getCoverageMeta).mockResolvedValueOnce({
      asOf: '2025-06-30',
      refreshedAt: '2025-07-01T00:00:00Z',
      coverageEndYear: 2025,
    });

    const result = await loader(loaderArgs());
    expect(result).toBeInstanceOf(Response);
    const wrapped = (await (result as Response).json()) as { page: { items: CompanyListItem[] } };

    await mount(Companies, wrapped);

    // The bare ЕИК MUST NOT appear anywhere in the rendered document — not as a `slug` value
    // inlined into a row, not as an `href`, not as a `<link rel>`, not as part of any visible text.
    // In production the bare ЕИК is also absent from the SSR hydration payload because the
    // mapper already substitutes the opaque slug for masked rows; the unit test above pins that
    // mapper-side invariant and this assertion re-pins it on the rendered output for symmetry.
    const html = container.innerHTML;
    expect(html).not.toContain('121817309'); // bare ЕИК absent
    // The legal entity's ЕИК MUST still be present (correctness regression — masking must NOT
    // over-reach and strip unmasked rows).
    expect(html).toContain('103267194');
    // The masked row must render as a `<span>`, not as an `<a>` to the opaque slug.
    expect(container.querySelector('a[href^="/companies/m"]')).toBeNull();
    expect(container.querySelector('a[href="/companies/121817309"]')).toBeNull();
    expect(container.textContent).toContain('Частно лице');
  });
});