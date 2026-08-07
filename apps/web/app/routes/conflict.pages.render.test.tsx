// @vitest-environment jsdom
// Deep render tests for the per-entity conflict pages (official, company) and the static methodology page.
// Each is mounted as a real route through createRoutesStub so ConflictCards/Link/useFetcher resolve, and the
// assertions check the ADR-0032 surface: an office-holder page omits the office-holder, a company page omits
// the company, and the methodology page states the three libel rails in plain language.
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictLink } from '@sigma/api-contract';
import ConflictOfficial, { meta as officialMeta } from './conflict.official';
import ConflictCompany, { meta as companyMeta } from './conflict.company';
import ConflictMethodology from './conflict.methodology';

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
    sourceUrl: 'https://register.cacbg.bg/2024/i.xml',
    ...over,
  };
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

async function mount(Component: ComponentType<{ loaderData: never }>, loaderData: unknown) {
  const Stub = createRoutesStub([
    {
      path: '/x',
      Component: () => <Component loaderData={loaderData as never} />,
      loader: () => loaderData,
    },
    {
      path: '/conflicts/link/:scope/:slug/:eik/contracts',
      loader: () => ({ linkKey: 'k', contracts: [] }),
    },
    { path: '/conflicts', Component: () => null },
    { path: '/conflicts/official/:slug', Component: () => null },
    { path: '/conflicts/company/:eik', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/x']} />);
  });
}
const text = () => container.textContent ?? '';

describe('/conflicts/official/:id — render', () => {
  it('names the official, omits the office-holder link on each card, shows the family label', async () => {
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [
        link({
          relation: 'related',
          company: 'ЕВРОСТРОЙ 21 ЕООД',
          eik: '333',
          ownInstitution: false,
        }),
      ],
    });
    expect(text()).toContain('Кмет Тестов'); // page header names the official
    expect(text()).toContain('ЕВРОСТРОЙ 21 ЕООД'); // the winner
    expect(text()).toContain('деклариран дял на свързано лице'); // family label
    // omit='official' → the card does NOT repeat the official's name as a link inside the card list
    const card = container.querySelector('.conflict-card')!;
    expect(card.textContent).not.toContain('Кмет Тестов');
  });

  it('meta() names the person in the title and marks the page noindex', () => {
    const tags = officialMeta({
      data: { official: 'Иван Петров', links: [] },
      matches: [],
      params: { id: 'aXZhbg' },
    } as never);
    expect(JSON.stringify(tags)).toContain('Иван Петров');
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });
});

describe('/conflicts/company/:eik — render', () => {
  it('names the company + ЕИК, omits the company link on each card, lists the officials', async () => {
    await mount(ConflictCompany as never, {
      company: 'ТРЕЙС ГРУП ХОЛД АД',
      eik: '111',
      links: [link(), link({ linkKey: 'k2', officialSlug: 's2', official: 'Втори Официал' })],
    });
    expect(text()).toContain('ТРЕЙС ГРУП ХОЛД АД');
    expect(text()).toContain('111'); // ЕИК in the header
    expect(text()).toContain('Иван Петров'); // an official is named
    expect(text()).toContain('Втори Официал');
    // omit='company' → the card does NOT repeat the company name link inside the card
    const card = container.querySelector('.conflict-card')!;
    expect(card.textContent).not.toContain('ТРЕЙС ГРУП ХОЛД АД');
  });

  it('meta() names the company and marks the page noindex', () => {
    const tags = companyMeta({
      data: { company: 'ТРЕЙС ГРУП ХОЛД АД', eik: '111', links: [] },
      matches: [],
      params: { eik: '111' },
    } as never);
    expect(JSON.stringify(tags)).toContain('ТРЕЙС ГРУП ХОЛД АД');
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });
});

describe('/conflicts/methodology — render', () => {
  it('states the three libel rails in plain language', async () => {
    await mount(ConflictMethodology as never, {});
    const t = text();
    // rail #1 — the relative's name is not shown/stored
    expect(t).toContain('Името на близкия');
    // rail #2 — the relationship type is never asserted
    expect(t).toContain('Не твърдим');
    expect(t).toContain('съпруг'); // stated in the negative: we do NOT write „съпруг"/„дете"
    // rail #3 — persons whose asset declaration is not public are excluded
    expect(t).toContain('чиято имуществена декларация не е публична');
    // the contest/correction anchor the leaderboard links to
    expect(container.querySelector('#contest, #shown')).not.toBeNull();
  });
});
