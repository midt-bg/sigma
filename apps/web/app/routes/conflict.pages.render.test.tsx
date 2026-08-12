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
    sourceUrl: 'https://register.cacbg.bg/2024/x.xml',
    // #279: a link only reaches the DTO when its identity rests on a Trade Register fact.
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20110502101007',
    registryEntryDate: '2011-05-02',
    registryLookupDate: '2026-08-05',
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

  it('a family-only page never asserts the official owns the stake (§2.6)', async () => {
    // The CARD labels were made tense-neutral and family-aware, but the page lede and the section hint
    // still read „декларирало собствен дял" — a second source of truth on the very page that renders a
    // relative's stake. On a family-only page that is a false claim about the named official, printed
    // above a card that correctly says „свързано лице".
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [link({ relation: 'related', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' })],
    });
    expect(text()).not.toContain('собствен дял');
    expect(text()).toContain('деклариран дял на свързано лице');
  });

  it('an own-stake page still says so — the wording is family-AWARE, not family-blind', async () => {
    // POSITIVE CONTROL. Removing the claim everywhere would satisfy the assertion above while making the
    // page vaguer than the data warrants: a self stake IS the official's own and should read that way.
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [link({ relation: 'owns', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' })],
    });
    expect(text()).toContain('собствен дял');
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
  it('discloses the matching rule verbatim — every rung, and what each may conclude', async () => {
    // ADR-0021 E10 makes this page the disclosure of the rule, and ADR-0033 decision 7 makes it a LAUNCH
    // CONDITION rather than a follow-up: a heuristic that asserts something about a named person is only
    // defensible if the reader can see exactly what was asserted and why. Nothing but a test keeps the
    // page in step with the ladder — the rule can change in evidence.mjs and leave the page describing a
    // system that no longer exists, which is worse than not disclosing it at all.
    await mount(ConflictMethodology as never, {});
    const t = text();
    // every rung of the ladder, by the name the seal and the card use
    for (const rung of ['Документ', 'Потвърдено', 'Оборена', 'Неизвестна'])
      expect(t).toContain(rung);
    // rung 1 — the joint-stock bar and its reason (the „11 акции" trap)
    expect(t).toContain('Акционерна форма');
    expect(t).toContain('не е публична');
    // rung 2 — all three names, one record, and the two refusals
    expect(t).toContain('пълно съвпадение и на трите имена');
    expect(t).toContain('един и същ запис');
    // ADR-0035 — the company gate, the part a reader most needs to judge the claim
    expect(t).toContain('Съвпадението по име само по себе си не стига');
    // R10 — the seat's temporal guard, both halves
    expect(t).toContain('вписано преди декларирания период');
    expect(t).toContain('когато този период е известен');
    // the honest limit: no ЕГН, so a homonym is possible
    expect(t).toContain('не съдържа ЕГН');
    expect(t).toContain('съименник');
    // what the register proves and what it does not — the distinction the whole surface rests on
    expect(t).toContain('самоличността на дружеството');
  });

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
