// @vitest-environment jsdom
// ConflictDetail is the rich per-link case detail. It was lifted out of the retired ConflictCards in
// #312, but the tests that covered its thinner row shapes lived in conflicts.render.test.tsx and went
// away with the card LIST — /conflicts is a person table now. The component survived; its edge
// branches did not keep their cover. This file restores it against the component directly.
//
// Every case here is a shape the feed really produces: a declaration with no usable period, a
// seat/ЕИК confirmation that cites no register act, a contract with no number, an authority that
// never resolved, and a winner whose amounts are all NULL.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictContract, ConflictContractFacts, ConflictLink } from '@sigma/api-contract';
import { ConflictDetail } from './ConflictDetail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function link(over: Partial<ConflictLink> = {}): ConflictLink {
  return {
    linkKey: 'person:ivan|111',
    officialSlug: 'aXZhbg',
    official: 'Иван Петров',
    institution: 'Община Тест',
    company: 'ТЕСТ ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: true,
    ownInstitution: true,
    firstDeclaredYear: '2019',
    lastDeclaredYear: '2023',
    matchMethod: 'exact_name_key',
    contractCount: 2,
    contractValueEur: 88_000_000,
    contemporaneousContractCount: 1,
    contemporaneousValueEur: 30_000_000,
    firstContractYear: '2020',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/2024/x.xml',
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20110502101007',
    registryEntryDate: '2011-05-02',
    registryLookupDate: '2026-08-05',
    position: null,
    sourceYear: null,
    ...over,
  };
}

function facts(over: Partial<ConflictContract> = {}): ConflictContractFacts {
  const { temporal: _drop, ...rest } = {
    contractSlug: 'e:abc',
    signedAt: '2021-05-01',
    authority: 'Община Пловдив',
    authorityId: 'auth1',
    authorityTotalEur: 5_000_000,
    contractKind: 'Услуги',
    procedureType: 'открита процедура',
    subject: 'Ремонт на улици',
    contractNumber: 'Д-1',
    amountEur: 1_000_000,
    temporal: 'contemporaneous' as const,
    ...over,
  };
  return rest;
}

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

async function renderAs(
  perspective: 'official' | 'company',
  links: ConflictLink[],
  byEik: Record<string, ConflictContractFacts[]>,
) {
  const Stub = createRoutesStub([
    {
      path: '/x',
      Component: () => <ConflictDetail links={links} contracts={byEik} perspective={perspective} />,
    },
    { path: '/companies/:eik', Component: () => null },
    { path: '/conflicts/official/:id', Component: () => null },
    { path: '/contracts/:id', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/x']} />);
  });
  return container;
}

async function render(links: ConflictLink[], byEik: Record<string, ConflictContractFacts[]>) {
  await renderAs('official', links, byEik);
}

it('shows a later omission separately from the precise end of a cited registry role', async () => {
  await render([link({ laterDeclarationYear: '2025', registryRoleEndedOn: '2024-03-10' })], {
    '111': [facts()],
  });
  expect(text()).not.toContain('исторически данни');
  expect(text()).toContain('по-късна съпоставима декларация');
  expect(text()).toContain('не установява точна дата на прекратяване');
  expect(text()).toContain('лицето е било вписано като съдружник/собственик до 2024-03-10');
  expect(text()).not.toContain('лицето е вписано като съдружник/собственик');
});

const text = () => container.textContent ?? '';

/**
 * The `<dd>` of the fact row named by its `<dt>`. The rows carry no per-field class — the block now uses
 * the shared `FactsList` (`.facts > .row`) — so a selector cannot name one, and a looser selector silently
 * widens to the whole block (review ydimitrof, #254): asserting „—" over the block passes on any other dash
 * on the page. Throwing on a miss is the point; a finder that returns null would restore exactly that hole.
 */
function statValue(label: string): HTMLElement {
  for (const cell of container.querySelectorAll('.facts .row')) {
    if (cell.querySelector('dt')?.textContent?.trim() === label) {
      const dd = cell.querySelector('dd');
      if (dd) return dd as HTMLElement;
    }
  }
  throw new Error(`no fact row labelled „${label}" — the row was renamed or removed`);
}

/**
 * A block renders three tables (authority shares, in-window contracts, out-of-window contracts) and two of
 * them have a „Възложител" column, so an unscoped `tbody td[data-label=…]` silently reads the wrong one.
 * Every table carries an sr-only caption; scope by it.
 */
function tableByCaption(needle: string): HTMLTableElement {
  const t = [...container.querySelectorAll('table')].find((tbl) =>
    tbl.querySelector('caption')?.textContent?.includes(needle),
  );
  if (!t) throw new Error(`no table captioned „${needle}"`);
  return t as HTMLTableElement;
}

const CONTRACTS_IN = 'Договори, сключени в декларирания период';
const CONTRACTS_OUT = 'Договори извън декларирания период';
const SHARES = 'Дял на дружеството';

/** A cell of the first row of a captioned table, by its column label. */
function cell(caption: string, label: string): HTMLElement {
  const td = [...tableByCaption(caption).querySelectorAll('tbody td')].find(
    (c) => c.getAttribute('data-label') === label,
  );
  if (!td) throw new Error(`no „${label}" cell in the „${caption}" table`);
  return td as HTMLElement;
}

describe('ConflictDetail — provenance on the thinner link shapes', () => {
  it('cites no act entry for a seat/ЕИК confirmation, and prints no bare „№"', async () => {
    // A 'confirmed' seal identifies the COMPANY from declared data; nobody was found in a register
    // act, so there is no entry number or date to cite. Printing the separators anyway would imply a
    // document behind the claim that does not exist.
    await render(
      [
        link({
          evidenceKind: 'confirmed',
          registryRole: null,
          registryEntryNumber: null,
          registryEntryDate: null,
        }),
      ],
      { '111': [facts()] },
    );
    const evidence = statValue('Регистър').querySelector('.sub')!.textContent ?? '';
    expect(evidence).toContain('дружеството е потвърдено');
    expect(evidence).not.toContain('№');
    expect(evidence).not.toContain('вписване');
    expect(evidence).toContain('справка'); // lookup_date is NOT NULL — it always says when we looked
  });

  it('renders „—" in the source cell itself for a link with no declaration URL', async () => {
    // Pinned to the „Източник" cell, not the card: the card holds several other „—" (Период, an
    // unresolved authority), so a card-wide assertion would pass with the cell deleted outright.
    await render([link({ sourceUrl: null })], { '111': [facts()] });
    expect(statValue('Източници').textContent?.trim()).toBe('—');
    expect(statValue('Източници').querySelector('a')).toBeNull();
    expect(container.querySelector('a[href^="https://register.cacbg.bg"]')).toBeNull();
  });

  it('renders the declaration link in that same cell when the URL is present', async () => {
    // The negative case above is only meaningful if the finder reaches the right cell — a broken
    // statValue() would make it pass by accident. This is the positive control for it.
    await render([link()], { '111': [facts()] });
    const link_ = statValue('Източници').querySelector('a')!;
    expect(link_.getAttribute('href')).toBe('https://register.cacbg.bg/2024/x.xml');
    expect(link_.textContent).toBe('декларация');
  });

  it('names the filing the stake comes from when its year is known', async () => {
    await render([link({ sourceYear: '2023' })], { '111': [facts()] });
    expect(statValue('Източници').querySelector('a')!.textContent).toBe('декларация за 2023 г.');
  });

  it('omits the declared-period line entirely when the declaration carries no usable years', async () => {
    await render([link({ firstDeclaredYear: null, lastDeclaredYear: null })], {
      '111': [facts()],
    });
    expect(text()).not.toContain('Деклариран период');
  });
});

describe('ConflictDetail — authority shares that cannot be plotted', () => {
  // The shares are a DataTable with a ShareBar in the „Дял" column (the same idiom as the company and
  // authority profiles). A share is plotted only when it is real; the two unplottable cases must stay
  // visibly different from „0%", which would be a false claim rather than a missing one.
  const shareCell = () => cell(SHARES, 'Дял');

  it('labels a sub-threshold capture „под 0,1%" and plots no bar', async () => {
    await render([link()], {
      '111': [facts({ amountEur: 1_000, authorityTotalEur: 500_000_000 })],
    });
    expect(shareCell().textContent).toBe('под 0,1%');
    expect(shareCell().querySelector('.share-bar')).toBeNull();
  });

  it('renders „—" and no bar at all when the authority total is unknown', async () => {
    // No denominator → no ratio. A „0%" here would read as "won nothing from this body", which is a
    // different and false claim from "we do not know what this body spent in total".
    await render([link()], { '111': [facts({ authorityTotalEur: null })] });
    expect(shareCell().textContent).toBe('—');
    expect(shareCell().querySelector('.share-bar')).toBeNull();
  });

  it('says the sum is unavailable rather than printing „0 €" when every amount is NULL', async () => {
    await render([link()], {
      '111': [facts({ amountEur: null, authorityTotalEur: null })],
    });
    const received = cell(SHARES, 'Получено (€)');
    expect(received.textContent).toBe('сума не е налична');
    expect(received.textContent).not.toContain('0');
  });
});

describe('ConflictDetail — the sparse shapes of a block', () => {
  it('omits the funds sub-line entirely when there is no total to compare against', async () => {
    // No in-window sum → `fundsCellLabel` collapses to the total alone, so there is nothing to say „от"
    // about. Printing „от —" would invent a comparison.
    await render([link({ contemporaneousContractCount: 0, contemporaneousValueEur: null })], {
      '111': [facts()],
    });
    const funds = statValue('Публични средства');
    expect(funds.querySelector('.sub')).toBeNull();
  });

  it('heads a company-perspective block by the official, with no institution line when unknown', async () => {
    const c = await renderAs('company', [link({ institution: null })], { '111': [facts()] });
    expect(c.querySelector('section[aria-labelledby^="link-"] .section-hint')).toBeNull();
  });

  it('renders the fallbacks for a contract with no procedure, kind or slug', async () => {
    await render([link()], {
      '111': [facts({ contractSlug: '', procedureType: null, contractKind: null })],
    });
    expect(cell(CONTRACTS_IN, 'Процедура').textContent).toBe('—');
    expect(cell(CONTRACTS_IN, 'Вид').textContent).toBe('—');
  });

  it('renders an out-of-window contract with no slug behind the disclosure', async () => {
    await render([link({ firstDeclaredYear: '2019', lastDeclaredYear: '2020' })], {
      '111': [facts({ contractSlug: '', signedAt: '2025-05-01' })],
    });
    expect(tableByCaption(CONTRACTS_OUT).querySelectorAll('tbody tr').length).toBe(1);
  });
});

describe('ConflictDetail — timeline and contract rows on sparse data', () => {
  it('plots the contract marks but no declared-period band when the window is unknown', async () => {
    // A declaration can carry no usable period while the contracts matched to it are dated. The axis
    // is still worth drawing; a band defaulted to 0 would render a zero-width marker at the left edge
    // that reads as „the period starts at the beginning of time".
    await render([link({ firstDeclaredYear: null, lastDeclaredYear: null })], {
      '111': [facts({ signedAt: '2022-07-01' })],
    });
    expect(container.querySelector('.tl-mark')).not.toBeNull();
    expect(container.querySelector('.tl-band')).toBeNull();
  });

  it('falls back to a generic label for a contract with no number and no subject', async () => {
    // The subject is the link text; with neither subject nor number there must still be a clickable
    // label, and two such contracts must render as two distinct rows rather than collapsing on one key.
    await render([link()], {
      '111': [
        facts({
          contractSlug: 'e:n1',
          contractNumber: null,
          subject: null,
          signedAt: '2020-02-02',
        }),
        facts({
          contractSlug: 'e:n2',
          contractNumber: null,
          subject: null,
          signedAt: '2020-03-03',
        }),
      ],
    });
    expect(tableByCaption(CONTRACTS_IN).querySelectorAll('tbody tr').length).toBe(2);
    expect(text()).toContain('Договор');
    expect(text()).not.toContain('№ null');
  });

  it('makes the subject itself the link, not a bare „№" token beside it', async () => {
    // The old list DID link every contract — but the anchor was the „№ …" token while the subject, the
    // only part a reader recognises, was a plain span. The link existed; the click target did not.
    await render([link()], {
      '111': [facts({ subject: 'Доставка на горива', contractNumber: 'Д-42' })],
    });
    const a = tableByCaption(CONTRACTS_IN).querySelector('tbody a')!;
    expect(a.textContent).toBe('Доставка на горива');
    expect(a.getAttribute('href')).toContain('/contracts/');
  });

  it('renders „—" for a contract whose awarding body never resolved', async () => {
    // getLinkContracts maps a NULL joined authority to '' (never null), so '' is the real shape.
    await render([link()], { '111': [facts({ authority: '', authorityId: 'a:bare' })] });
    expect(cell(CONTRACTS_IN, 'Възложител').textContent).toBe('—');
  });

  it('marks only in-window contracts as conflicting, leaving outside ones unflagged', async () => {
    // The `conflict` flag drives the row's modifier class. An outside-window contract is disclosed
    // but never asserted as a conflict — the distinction the whole surface rests on.
    await render([link({ firstDeclaredYear: '2019', lastDeclaredYear: '2023' })], {
      '111': [
        facts({ contractSlug: 'e:in', subject: 'ВЪТРЕ', signedAt: '2021-05-01' }),
        facts({ contractSlug: 'e:out', subject: 'ИЗВЪН', signedAt: '2025-05-01' }),
      ],
    });
    // Rendering both rows is not the claim — WHICH table each lands in is. Asserting only presence
    // passes with the in/out-window split fully broken in either direction (review ydimitrof, #254).
    // Each contract lands in its OWN table, and the out-of-window one stays behind the „Извън периода"
    // disclosure — disclosed, never asserted as a conflict.
    expect(tableByCaption(CONTRACTS_IN).textContent).toContain('ВЪТРЕ');
    expect(tableByCaption(CONTRACTS_IN).textContent).not.toContain('ИЗВЪН');
    expect(tableByCaption(CONTRACTS_OUT).textContent).toContain('ИЗВЪН');
    expect(tableByCaption(CONTRACTS_OUT).textContent).not.toContain('ВЪТРЕ');
    const outside = container.querySelector('.contract-outside')!;
    expect(outside.contains(tableByCaption(CONTRACTS_OUT))).toBe(true);
    expect(outside.contains(tableByCaption(CONTRACTS_IN))).toBe(false);
    // …and the outside table tags each row's position relative to the window, which the in-window
    // table needs no column for — its heading already says it.
    expect(tableByCaption(CONTRACTS_OUT).textContent).toContain('период');
  });
});

describe('ConflictDetail — the declarations and contracts behind a block', () => {
  type Declaration = NonNullable<ConflictLink['declarations']>[number];
  const doc = (over: Partial<Declaration> = {}): Declaration => ({
    id: 'd1',
    year: '2022',
    template: 'interests',
    type: 'Annual',
    declaredOn: '2023-05-01',
    submittedOn: '2023-05-02',
    institution: 'Община Тест',
    position: 'Кмет',
    url: 'https://register.cacbg.bg/2023/d1.xml',
    companyEiks: ['111'],
    ...over,
  });

  it('names the institutions its sources cite and lists every document in the block', async () => {
    const d2 = doc({
      id: 'd2',
      year: '2023',
      institution: 'Министерство на теста',
      position: null,
    });
    await render([link({ declarations: [doc(), d2] })], { '111': [facts()] });
    expect(statValue('Институции в източниците').textContent).toBe(
      'Министерство на теста; Община Тест',
    );
    const list = container.querySelector('#sources-link-1-111')!;
    expect(list.querySelector('h3')!.textContent).toBe('Декларации за тази връзка (2)');
    expect(list.querySelectorAll('.declarations.compact tbody tr')).toHaveLength(2);

    const sources = statValue('Източници').querySelector('a')!;
    expect(sources.textContent).toBe('Виж всички декларации (2)');
    expect(sources.getAttribute('href')).toBe('#sources-link-1-111');
    const jump = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      sources.dispatchEvent(jump);
    });
    expect(jump.defaultPrevented).toBe(false); // a plain in-page jump to the list, which is always open
    history.replaceState(null, '', location.pathname);
  });

  it('notes the years the declarations disagree on, and neither bands nor counts them as in the period', async () => {
    await render([link({ disputedYears: ['2021'] })], {
      '111': [
        facts({ contractSlug: 'e:a', signedAt: '2022-03-01' }),
        facts({ contractSlug: 'e:b', signedAt: '2021-03-01' }),
      ],
    });
    expect(container.querySelector('.cc-interest')!.textContent).toContain(
      'деклариран 2019 – 2023 г. · разминаване в декларациите за 2021 г.',
    );
    const marks = Object.fromEntries(
      [...container.querySelectorAll('.tl-mark')].map((m) => [
        m.getAttribute('title'),
        m.className,
      ]),
    );
    expect(marks).toEqual({ '2022': 'tl-mark in', '2021': 'tl-mark out' });
    expect(container.querySelector('.tl-band')).toBeNull();
  });

  it('names a contract with no subject by its number', async () => {
    await render([link()], { '111': [facts({ subject: null, contractNumber: 'Д-7' })] });
    expect(cell(CONTRACTS_IN, 'Предмет').textContent).toBe('Договор № Д-7');
  });

  it('sends the reader to the page’s contract list instead of repeating the contracts', async () => {
    const Stub = createRoutesStub([
      {
        path: '/x',
        Component: () => (
          <ConflictDetail
            links={[link()]}
            contracts={{ '111': [facts()] }}
            perspective="official"
            contractListHref="/persons/ab"
          />
        ),
      },
    ]);
    await act(async () => {
      root.render(<Stub initialEntries={['/x']} />);
    });
    const action = container.querySelector('.detail-contract-action a')!;
    expect(action.textContent).toBe('Виж договорите на ТЕСТ ГРУП ХОЛД АД в общия списък →');
    expect(action.getAttribute('href')).toBe('/persons/ab?company=111&basis=declaration#contracts');
    expect(container.querySelector('.tl-track')).not.toBeNull(); // the timeline stays in the block
    expect(container.querySelector('table')).toBeNull(); // the shares and contracts live in that list
  });
});
