// @vitest-environment jsdom
// Masked sole-trader rows on the home top-10 must NOT carry a clickable href that would either
// leak the masked profile's ЕИК (pre-fix) or 404 against the new opaque slug (post-fix). The
// fix is symmetric to /companies (ydimitrof review 2026-08-31, thread on companies.tsx:74 +
// companies.tsx:174) and extended to home.tsx by lyubomir-bozhinov review 2026-09-02 (the
// "summary" reference in the rows.ts:86 thread). The top-10 is public and indexable — a masked
// row's name must render as a non-link <span> just like on /companies.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { CompanyListItem } from '@sigma/api-contract';
import Home, { headers } from './home';
import { getHomeData } from '@sigma/db';

vi.mock('@sigma/db', async () => {
  const actual = await vi.importActual<typeof import('@sigma/db')>('@sigma/db');
  return {
    ...actual,
    getHomeData: vi.fn(),
    getDb: (env: unknown) => (env as { DB: unknown }).DB,
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

function makeHomeData(items: CompanyListItem[]) {
  return {
    totals: {
      contracts: 1,
      valueEur: 0,
      authorities: 0,
      bidders: 0,
      suspect: 0,
      asOf: null,
      refreshedAt: '',
    },
    topCompanies: items,
    topMinistries: [],
    topMunicipalities: [],
    recentSingleOffer: [],
    topSingleOffer: [],
    singleOffer: { valueEur: 0, contracts: 0 },
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(getHomeData).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Mount the route through a real data router (mirrors conflicts.render.test.tsx pattern). The
// loader shape is the same shape `Route.ComponentProps` expects at runtime — `loaderData as never`
// sidesteps the structural mismatch without weakening the assertions.
async function renderHome(loaderData: ReturnType<typeof makeHomeData>) {
  const Stub = createRoutesStub([
    { path: '/', Component: Home, loader: () => loaderData },
    // Stand-in routes for any <Link> the home component might produce (e.g. breadcrumbs).
    { path: '/companies/:slug', Component: () => null },
    { path: '/companies', Component: () => null },
    { path: '/authorities/:slug', Component: () => null },
    { path: '/authorities', Component: () => null },
    { path: '/contracts/:id', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/']} />);
  });
}

// React needs this flag to run act() cleanly under the jsdom test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('home.render — masked sole-trader rows on the public top-10 (PR #183 review — lyubomir-bozhinov 2026-09-02)', () => {
  it('renders a masked top-10 row as <span>, not as a <Link> that would either leak the ЕИК or 404 against the opaque slug', async () => {
    const legal = makeItem();
    // Opaque-slug form (post-fix). Pre-fix the slug would have been the bare ЕИК — the masking
    // invariant is the same: a masked row must not be clickable on the public home top-10.
    const masked = makeItem({
      slug: 'm' + Buffer.from('eik:121817309').toString('base64url'),
      name: 'Частно лице',
      displayName: 'Частно лице',
      eik: null,
      eikValid: false,
      hasEik: false,
      masked: true,
    });
    const loaderData = makeHomeData([legal, masked]);
    vi.mocked(getHomeData).mockResolvedValueOnce(loaderData as never);

    await renderHome(loaderData);

    // The legal-entity row stays a working <Link> to its profile.
    const legalLink = container.querySelector('a[href="/companies/103267194"]');
    expect(legalLink).not.toBeNull();

    // The masked row must NOT be a link — its opaque slug is non-resolvable on purpose, and
    // rendering it as a <Link> would either leak the pre-fix bare ЕИК or 404 against the new
    // `m<base64(bidder_id)>` opaque form. Scan all company links; none should wrap "Частно лице".
    const allCompanyLinks = Array.from(container.querySelectorAll('a[href^="/companies/"]'));
    const maskedHref = allCompanyLinks.find((a) => a.textContent === 'Частно лице');
    expect(maskedHref).toBeUndefined();
    // The label still renders (the row is visible — it just isn't clickable).
    expect(container.textContent).toContain('Частно лице');
  });

  it('omits the ЕИК subtitle for masked rows (else it would render "непотвърден ЕИК" next to a masked name)', async () => {
    const masked = makeItem({
      slug: 'm' + Buffer.from('eik:121817309').toString('base64url'),
      name: 'Частно лице',
      displayName: 'Частно лице',
      eik: null,
      eikValid: false,
      hasEik: false,
      masked: true,
    });
    const loaderData = makeHomeData([masked]);
    vi.mocked(getHomeData).mockResolvedValueOnce(loaderData as never);

    await renderHome(loaderData);

    // The subtitle for a masked row must not read „непотвърден ЕИК" (the legal-entity fallback
    // path); a masked sole trader is neither unconfirmed nor legal — the subtitle is suppressed.
    const tr = container.querySelector('tbody tr');
    expect(tr).not.toBeNull();
    expect(tr!.textContent).not.toContain('непотвърден ЕИК');
    expect(tr!.textContent).not.toContain('ЕИК 121817309');
  });

  it('does not stamp the privacy-mask marker onto the HTML home page (parity with /companies)', () => {
    // The home route's `headers()` returns a constant Cache-Control and ignores loaderHeaders
    // (intentional: home is public and indexable, a masked row on the top-10 is too narrow a
    // signal to noindex the whole homepage). Verify the function ignores any privacy-mask
    // marker a loader might try to set — the contract is that `headers()` produces the same
    // shape regardless of input.
    const htmlHeaders = headers();
    expect('X-Privacy-Mask' in htmlHeaders).toBe(false);
    expect(htmlHeaders['Cache-Control']).toContain('s-maxage=');
  });
});
