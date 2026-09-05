// @vitest-environment jsdom
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { CompanyListItem } from '@sigma/api-contract';
import { getCoverageMeta } from '../lib/coverage';
import { getCompanyFacets, listCompanies } from '@sigma/db';
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
    const masked = makeItem({
      slug: '121817309', // companySlug('eik:121817309') === '121817309' — the ЕИК is in the slug
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