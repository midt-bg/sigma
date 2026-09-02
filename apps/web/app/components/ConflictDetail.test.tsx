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
    company: 'ТРЕЙС ГРУП ХОЛД АД',
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

async function render(links: ConflictLink[], byEik: Record<string, ConflictContractFacts[]>) {
  const Stub = createRoutesStub([
    {
      path: '/x',
      Component: () => <ConflictDetail links={links} contracts={byEik} perspective="official" />,
    },
    { path: '/companies/:eik', Component: () => null },
    { path: '/contracts/:id', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/x']} />);
  });
}

const text = () => container.textContent ?? '';

/**
 * The `<dd>` of the „…" stat cell named by its `<dt>`. The cells carry no per-field class — they are
 * all `.cc-stat` — so a selector cannot name one, and a looser selector silently widens to the whole
 * card (review ydimitrof, #254): asserting „—" over the card passes on any other dash on the page.
 * Throwing on a miss is the point; a finder that returns null would restore exactly that hole.
 */
function statValue(label: string): HTMLElement {
  for (const cell of container.querySelectorAll('.cc-stat')) {
    if (cell.querySelector('dt')?.textContent?.trim() === label) {
      const dd = cell.querySelector('dd');
      if (dd) return dd as HTMLElement;
    }
  }
  throw new Error(`no .cc-stat labelled „${label}" — the cell was renamed or removed`);
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
    const evidence = container.querySelector('.cc-evidence')!.textContent ?? '';
    expect(evidence).toContain('потвърдена');
    expect(evidence).not.toContain('№');
    expect(evidence).not.toContain('вписване');
    expect(evidence).toContain('справка'); // lookup_date is NOT NULL — it always says when we looked
  });

  it('renders „—" in the source cell itself for a link with no declaration URL', async () => {
    // Pinned to the „Източник" cell, not the card: the card holds several other „—" (Период, an
    // unresolved authority), so a card-wide assertion would pass with the cell deleted outright.
    await render([link({ sourceUrl: null })], { '111': [facts()] });
    expect(statValue('Източник').textContent?.trim()).toBe('—');
    expect(statValue('Източник').querySelector('a')).toBeNull();
    expect(container.querySelector('a[href^="https://register.cacbg.bg"]')).toBeNull();
  });

  it('renders the declaration link in that same cell when the URL is present', async () => {
    // The negative case above is only meaningful if the finder reaches the right cell — a broken
    // statValue() would make it pass by accident. This is the positive control for it.
    await render([link()], { '111': [facts()] });
    const link_ = statValue('Източник').querySelector('a')!;
    expect(link_.getAttribute('href')).toBe('https://register.cacbg.bg/2024/x.xml');
    expect(link_.textContent).toBe('декларация');
  });

  it('omits the declared-period line entirely when the declaration carries no usable years', async () => {
    await render([link({ firstDeclaredYear: null, lastDeclaredYear: null })], {
      '111': [facts()],
    });
    expect(text()).not.toContain('Деклариран период');
  });
});

describe('ConflictDetail — authority shares that cannot be plotted', () => {
  it('labels a sub-threshold capture „под 0,1%" and plots no bar inside the track', async () => {
    await render([link()], {
      '111': [facts({ amountEur: 1_000, authorityTotalEur: 500_000_000 })],
    });
    expect(text()).toContain('под 0,1%');
    expect(container.querySelector('.auth-bar')).not.toBeNull(); // the track renders…
    expect(container.querySelector('.auth-bar i')).toBeNull(); // …but nothing is filled in
    expect(container.querySelector('.auth-share-pct.is-muted')).not.toBeNull();
  });

  it('renders „—" and no track at all when the authority total is unknown', async () => {
    // No denominator → no ratio. A „0%" here would read as "won nothing from this body", which is a
    // different and false claim from "we do not know what this body spent in total".
    await render([link()], { '111': [facts({ authorityTotalEur: null })] });
    const pctCell = container.querySelector('.auth-share-pct')!;
    expect(pctCell.textContent).toBe('—');
    expect(pctCell.className).toContain('is-muted');
    expect(container.querySelector('.auth-bar')).toBeNull();
  });

  it('says the sum is unavailable rather than printing „0 €" when every amount is NULL', async () => {
    await render([link()], {
      '111': [facts({ amountEur: null, authorityTotalEur: null })],
    });
    expect(text()).toContain('сума не е налична');
    expect(container.querySelector('.auth-share-figures')!.textContent).not.toContain('0');
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

  it('falls back to a generic label and an index key for a contract with no number', async () => {
    // contractNumber is the React key for in-window rows; two unnumbered contracts must still render
    // as two distinct rows rather than collapsing onto one key.
    await render([link()], {
      '111': [
        facts({ contractSlug: 'e:n1', contractNumber: null, signedAt: '2020-02-02' }),
        facts({ contractSlug: 'e:n2', contractNumber: null, signedAt: '2020-03-03' }),
      ],
    });
    expect(container.querySelectorAll('.contract-list li').length).toBe(2);
    expect(text()).toContain('договор');
    expect(text()).not.toContain('№ null');
  });

  it('renders „—" for a contract whose awarding body never resolved', async () => {
    // getLinkContracts maps a NULL joined authority to '' (never null), so '' is the real shape.
    await render([link()], { '111': [facts({ authority: '', authorityId: 'a:bare' })] });
    expect(container.querySelector('.contract-authority')!.textContent).toBe('—');
  });

  it('marks only in-window contracts as conflicting, leaving outside ones unflagged', async () => {
    // The `conflict` flag drives the row's modifier class. An outside-window contract is disclosed
    // but never asserted as a conflict — the distinction the whole surface rests on.
    await render([link({ firstDeclaredYear: '2019', lastDeclaredYear: '2023' })], {
      '111': [
        facts({ contractSlug: 'e:in', contractNumber: 'Д-IN', signedAt: '2021-05-01' }),
        facts({ contractSlug: 'e:out', contractNumber: 'Д-OUT', signedAt: '2025-05-01' }),
      ],
    });
    const row = (number: string) =>
      [...container.querySelectorAll('.contract-list li')].find((li) =>
        li.textContent?.includes(number),
      )!;

    // Rendering both rows is not the claim — WHICH one carries the conflict modifier is. Asserting
    // only presence passes with the in/out-window split fully broken in either direction
    // (review ydimitrof, #254).
    expect(row('Д-IN')).toBeDefined();
    expect(row('Д-OUT')).toBeDefined();
    expect(row('Д-IN').className).toContain('contract-item-conflict');
    expect(row('Д-OUT').className).not.toContain('contract-item-conflict');
    // The out-of-window row is disclosed, but behind the „Извън периода" disclosure, never asserted.
    expect(container.querySelector('.contract-outside')!.contains(row('Д-OUT'))).toBe(true);
    expect(container.querySelector('.contract-outside')!.contains(row('Д-IN'))).toBe(false);
  });
});
