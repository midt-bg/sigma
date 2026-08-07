// @vitest-environment jsdom
// Deep render tests for the /conflicts leaderboard route and its ConflictCards. These exercise the ACTUAL
// route component + card tree against realistic loader data (framework-mode `loaderData`), driven through a
// real React Router data router (createRoutesStub) so useSearchParams/useFetcher/Link all resolve. The
// per-contract expansion is fetched through a stubbed `/conflicts/link/.../contracts` loader, so the lazily
// rendered CaseDetail (magnitude bar, timeline, authority shares, contract list) is covered end to end.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictContract, ConflictLink } from '@sigma/api-contract';
import Conflicts, { meta, headers } from './conflicts';

// React needs this flag to run act() cleanly under the jsdom test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── fixtures ──────────────────────────────────────────────────────────────────
function link(over: Partial<ConflictLink> = {}): ConflictLink {
  return {
    linkKey: 'person:ivan|111',
    officialSlug: 'aXZhbg',
    official: 'Иван Петров',
    institution: 'Община Тест',
    company: 'ТРЕЙС ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: true,
    ownInstitution: true,
    firstDeclaredYear: '2019',
    lastDeclaredYear: '2023',
    matchMethod: 'exact_name_key',
    contractCount: 3,
    contractValueEur: 88_000_000,
    contemporaneousContractCount: 2,
    contemporaneousValueEur: 30_000_000,
    firstContractYear: '2020',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/2024/i.xml',
    ...over,
  };
}

const familyLink = link({
  linkKey: 'person:kmet|333|family',
  officialSlug: 'a21ldA',
  official: 'Кмет Тестов',
  company: 'ЕВРОСТРОЙ 21 ЕООД',
  eik: '333',
  relation: 'related', // a close relative's stake — anonymized
  ownInstitution: false,
  contractCount: 1,
  contractValueEur: 250_000,
  contemporaneousContractCount: 1,
  contemporaneousValueEur: 250_000,
});

const zeroContractLink = link({
  linkKey: 'person:praz|900',
  officialSlug: 'cHJheg',
  official: 'Празен Тестов',
  company: 'ПРАЗЕН ООД',
  eik: '900',
  contemporaneous: false,
  ownInstitution: false,
  contractCount: 0,
  contractValueEur: null,
  contemporaneousContractCount: 0,
  contemporaneousValueEur: null,
  sourceUrl: null, // no declaration URL → the „—" source branch
});

const CONTRACTS: ConflictContract[] = [
  {
    contractSlug: 'c-in',
    signedAt: '2021-05-01',
    authority: 'Община Тест',
    authorityId: 'a:1',
    authorityTotalEur: 50_000_000,
    contractKind: 'Строителство',
    procedureType: 'открита процедура',
    subject: 'Ремонт на път',
    contractNumber: 'Д-1',
    amountEur: 10_000_000,
    temporal: 'contemporaneous',
  },
  {
    contractSlug: 'c-after',
    signedAt: '2024-02-01',
    authority: 'Община Тест',
    authorityId: 'a:1',
    authorityTotalEur: 50_000_000,
    contractKind: null,
    procedureType: 'договаряне без обявление',
    subject: 'Доставка на софтуер',
    contractNumber: 'Д-3',
    amountEur: 5_000_000,
    temporal: 'after',
  },
];

// ── jsdom render harness ───────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mount the /conflicts route through a real data router with the drill-down loader stubbed. */
async function renderConflicts(links: ConflictLink[], contracts: ConflictContract[] = CONTRACTS) {
  const Stub = createRoutesStub([
    { path: '/conflicts', Component: Conflicts, loader: () => ({ links }) },
    {
      path: '/conflicts/link/:scope/:slug/:eik/contracts',
      loader: ({ params }) => ({
        linkKey: `${params.slug}|${params.eik}${params.scope === 'family' ? '|family' : ''}`,
        contracts,
      }),
    },
    { path: '/conflicts/official/:slug', Component: () => null },
    { path: '/conflicts/company/:eik', Component: () => null },
    { path: '/conflicts/methodology', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/conflicts']} />);
  });
}

const text = () => container.textContent ?? '';

/** Click the first card's „Виж договорите" toggle and let the stubbed drill-down fetcher settle. */
async function expandFirstCard() {
  const toggle = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('договорите'),
  )!;
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('/conflicts route — render', () => {
  it('meta() marks the page noindex and titles it', () => {
    const tags = meta({ matches: [] } as never);
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
    expect(JSON.stringify(tags)).toContain('Свързани лица');
  });

  it('headers() carries the loader Cache-Control through', () => {
    const h = headers({
      loaderHeaders: new Headers({ 'Cache-Control': 'public, max-age=42' }),
    } as never);
    expect(h['Cache-Control']).toBe('public, max-age=42');
  });

  it('renders the empty state when there are no links (no summary, no cards)', async () => {
    await renderConflicts([]);
    expect(text()).toContain('Все още няма публикувани връзки');
    expect(container.querySelector('.conflict-cards')).toBeNull();
  });

  it('renders the summary totals and the magnitude bar for a populated leaderboard', async () => {
    await renderConflicts([link(), familyLink]);
    // summary facts
    expect(text()).toContain('Длъжностни лица с деклариран дял');
    expect(text()).toContain('Връзки към изпълнители');
    // contemporaneous magnitude bar renders only when both totals are > 0
    expect(container.querySelector('.conflict-headline-mag')).not.toBeNull();
    expect(container.querySelector('.share-bar, [class*="share"]')).not.toBeNull();
  });

  it('renders a self card AND a family card, labelled distinctly; the relative is never named', async () => {
    await renderConflicts([link(), familyLink]);
    const cards = container.querySelectorAll('.conflict-card');
    expect(cards.length).toBe(2);
    // self label vs family label (ADR-0032) — both present
    expect(text()).toContain('дялово участие'); // self
    // the FAMILY card names the office-holder + company and uses the anonymized „свързано лице"
    // framing only — no relative name, no relationship type asserted (rails #1 & #2).
    const familyCard = [...cards].find((c) => c.textContent?.includes('ЕВРОСТРОЙ 21 ЕООД'))!;
    expect(familyCard.textContent).toContain('деклариран дял на свързано лице');
    expect(familyCard.textContent).toContain('Кмет Тестов'); // the OFFICIAL is named
    expect(familyCard.textContent).not.toContain('съпруг'); // relationship type never asserted on the card
    expect(familyCard.textContent).not.toContain('дете');
    // own-institution chip present on the self link, absent on the family one
    expect(text()).toContain('от собствената институция');
  });

  it('renders the source declaration link, and „—" when a link has no source URL', async () => {
    await renderConflicts([link(), zeroContractLink]);
    const sourceAnchor = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === 'декларация',
    );
    expect(sourceAnchor?.getAttribute('href')).toBe('https://register.cacbg.bg/2024/i.xml');
    // the zero-contract link has no toggle (contractCount === 0) and a muted „—" source
    expect(text()).toContain('—');
  });

  it('a zero-contract link renders no „Виж договорите" toggle', async () => {
    await renderConflicts([zeroContractLink]);
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Виж договорите'),
      ),
    ).toBe(false);
  });

  it('expanding a card lazily loads and renders the case detail (timeline, authority shares, contract list)', async () => {
    await renderConflicts([link()]);
    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Виж договорите'),
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle.click();
    });
    // give the fetcher a tick to resolve the stubbed loader
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // the in-window contract is grouped under the declared-period heading; the after contract sits outside
    expect(text()).toContain('в декларирания период');
    expect(text()).toContain('Ремонт на път'); // subject of the in-window contract
    expect(text()).toContain('Дял при възложителите'); // authority-shares section
    expect(container.querySelector('.contract-list')).not.toBeNull();
    expect(text()).toContain('Извън периода'); // the „after" contract is disclosed but not asserted
  });

  it('renders an undated, unnumbered, authority-less contract without a timeline or shares', async () => {
    // Sparse feed row: no signedAt (contractTimeline returns null → no timeline section), no authority
    // name („—"), no contract number („договор" + index-keyed), and amountEur 0 (share mode 'no-value').
    // The card must still render the contract list rather than blanking or throwing on the nullish fields.
    await renderConflicts(
      [link({ firstDeclaredYear: null, lastDeclaredYear: null })], // also drops the declared-years line
      [
        {
          contractSlug: 'c-bare',
          signedAt: null,
          // getLinkContracts maps a NULL joined authority to '' (never null), so '' is the real
          // shape the card receives for an unresolved awarding body.
          authority: '',
          authorityId: 'a:bare',
          authorityTotalEur: null,
          contractKind: null,
          procedureType: null,
          subject: 'Без дата',
          contractNumber: null,
          amountEur: 0,
          temporal: 'after',
        },
      ],
    );
    await expandFirstCard();

    expect(container.querySelector('.contract-list')).not.toBeNull();
    expect(text()).toContain('Без дата');
    expect(text()).toContain('договор'); // contractNumber null → generic label, not „№ null"
    expect(text()).not.toContain('№ null');
    expect(container.querySelector('.contract-authority')!.textContent).toBe('—');
    expect(container.querySelector('.timeline, .cc-timeline')).toBeNull(); // undated → no timeline
    expect(text()).toContain('сума не е налична'); // companyEur 0 → the no-value share row
  });

  it('renders a sub-threshold authority share as „под 0,1%" with no plotted bar', async () => {
    await renderConflicts(
      [link()],
      [
        {
          contractSlug: 'c-tiny',
          signedAt: '2021-05-01',
          authority: 'Огромна Община',
          authorityId: 'a:big',
          authorityTotalEur: 10_000_000_000,
          contractKind: null,
          procedureType: null,
          subject: 'Дребна доставка',
          contractNumber: 'Д-9',
          amountEur: 1_000, // 0.00001 of the total → below the tiny threshold
          temporal: 'contemporaneous',
        },
      ],
    );
    await expandFirstCard();

    expect(text()).toContain('под 0,1%');
    expect(container.querySelector('.auth-share-pct')!.className).toContain('is-muted');
    expect(container.querySelector('.auth-bar i')).toBeNull(); // muted row plots no fill
  });

  it('renders „—" for a share with no denominator (authority total unknown)', async () => {
    await renderConflicts(
      [link()],
      [
        {
          contractSlug: 'c-nodenom',
          signedAt: '2021-05-01',
          authority: 'Община Без Общо',
          authorityId: 'a:nd',
          authorityTotalEur: null, // no denominator → ratio null → 'no-denom'
          contractKind: null,
          procedureType: null,
          subject: 'Доставка',
          contractNumber: 'Д-7',
          amountEur: 500_000,
          temporal: 'contemporaneous',
        },
      ],
    );
    await expandFirstCard();

    const pctCell = container.querySelector('.auth-share-pct')!;
    expect(pctCell.textContent).toBe('—');
    expect(pctCell.className).toContain('is-muted');
    expect(text()).not.toContain('от общо'); // no denominator to quote
  });

  it('renders the empty-contracts state when the drill-down returns none', async () => {
    await renderConflicts([link()], []);
    await expandFirstCard();
    expect(text()).toContain('Няма намерени договори.');
  });

  it('omits the in-window group when every contract falls outside the declared period', async () => {
    await renderConflicts([link()], [CONTRACTS[1]!]); // the 'after' contract only
    await expandFirstCard();
    expect(text()).toContain('Извън периода');
    // The in-window group collapses to its empty note instead of an empty heading + list.
    expect(text()).toContain('Няма договори, сключени в декларирания период.');
    expect(container.querySelector('.contract-list')).not.toBeNull(); // the outside group still lists
  });

  it('paginates when the eligible set exceeds one page (100), showing one page of cards', async () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      link({
        linkKey: `k${i}`,
        officialSlug: `s${i}`,
        official: `Лице ${i}`,
        eik: String(1000 + i),
      }),
    );
    await renderConflicts(many);
    expect(container.querySelectorAll('.conflict-card').length).toBe(100); // one page
    expect(
      container.querySelector('.pagination, nav[aria-label], [class*="pagination"]'),
    ).not.toBeNull();
  });
});
