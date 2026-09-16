import { emptyActivity } from '../lib/person-profile.test-support';
// @vitest-environment jsdom
// Deep render tests for the person page and the static methodology page. Each is mounted as a real route
// through createRoutesStub so Link resolves, and the assertions check the ADR-0032 surface: a person page
// heads each block by the winning company and never repeats the person inside a block, and the methodology
// page states the three libel rails in plain language. Since #287 the rich detail (per-company/per-official breakdown
// with ЕИК + profile link, timeline, „Дял при възложителите", contract split) is rendered EAGERLY here —
// no expand click — because the /conflicts list is now a lean one-row-per-person table.
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictContract, ConflictLink, PersonDeclaration } from '@sigma/api-contract';
import Person, { meta as personMeta } from './person';
import ConflictMethodology from './conflict.methodology';

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
    position: null,
    sourceYear: null,
    ...over,
  };
}

function contract(over: Partial<ConflictContract> = {}): ConflictContract {
  return {
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
    temporal: 'contemporaneous',
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
  if (Component === (Person as unknown)) {
    const d = loaderData as {
      official: string;
      links: ConflictLink[];
      contracts?: Record<string, ConflictContract[]>;
      declarations?: PersonDeclaration[];
    };
    loaderData = {
      ...d,
      name: d.official,
      person: null,
      timeline: {
        contracts: Object.entries(d.contracts ?? {}).flatMap(([eik, rows]) =>
          rows.map((c) => ({
            eik,
            company: d.links.find((l) => l.eik === eik)?.company ?? eik,
            year: c.signedAt?.slice(0, 4) ?? null,
            contracts: 1,
            eligible: c.temporal === 'contemporaneous' ? 1 : 0,
            role: 0,
            declared: c.temporal === 'contemporaneous' ? 1 : 0,
            valueEur: c.amountEur,
          })),
        ),
        observations: [],
        reads: [],
        buyers: [],
        institutionProfiles: [],
      },
      declarations: d.declarations ?? [],
      tieLayout: null,
      aliases: [],
      activity: emptyActivity,
      totals: {
        companies: new Set(d.links.map((l) => l.eik)).size,
        contracts: 0,
        valueEur: null,
        declaredCount: 0,
        declaredEur: null,
      },
      contracts: d.contracts ?? {},
    };
  }
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
    { path: '/persons/:id', Component: () => null },
    { path: '/companies/:eik', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/x']} />);
  });
}
const text = () => container.textContent ?? '';

/**
 * One link's detail block. It used to be `<article class="conflict-detail">` — a card idiom no other page
 * had; it is now a plain `<Section>`, identified by the `link-<n>-<ЕИК>` id its heading
 * carries. Throwing on a miss keeps the assertions below honest: a null block would make every
 * `not.toContain` pass vacuously.
 */
function detailBlock(): HTMLElement {
  const el = container.querySelector('section[aria-labelledby^="link-"]');
  if (!el) throw new Error('no detail <Section> rendered');
  return el as HTMLElement;
}

describe('/persons/:id — render', () => {
  it('puts distinct declared institutions, positions and observed years above the source documents', async () => {
    const declaration = (
      institution: string,
      position: string,
      year: string,
    ): PersonDeclaration => ({
      id: year,
      year,
      institution,
      position,
      template: 'assets',
      type: 'Annualy',
      declaredOn: null,
      submittedOn: null,
      url: `https://example.test/${year}`,
      companyEiks: ['111'],
    });
    await mount(Person as never, {
      official: 'Иван Петров',
      links: [link()],
      declarations: [
        declaration('Община Русе', 'Съветник', '2019'),
        declaration('Народно събрание', 'Народен представител', '2025'),
      ],
    });
    const institutions = container.querySelector('#timeline')!.closest('section')!;
    expect(institutions.textContent).toContain('Община Русе');
    expect(institutions.textContent).toContain('Съветник');
    expect(institutions.textContent).toContain('2019');
    expect(institutions.textContent).toContain('Народно събрание');
    expect(institutions.textContent).toContain('Народен представител');
    expect(institutions.textContent).toContain('2025');
    expect(institutions.textContent).toContain('не установява точен мандат');
    expect(
      institutions.compareDocumentPosition(container.querySelector('#declarations')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it('heads each block by the winning company (ЕИК + profile link), never repeats the official inside', async () => {
    const l = link({
      linkKey: 'k1',
      relation: 'related',
      company: 'ЕВРОСТРОЙ 21 ЕООД',
      eik: '333',
      ownInstitution: false,
    });
    await mount(Person as never, {
      official: 'Кмет Тестов',
      links: [l],
      contracts: { '333': [contract({ authority: 'Община Тест' })] }, // keyed by ЕИК (#312 HIGH 1)
    });
    expect(text()).toContain('Кмет Тестов'); // page header names the official
    expect(text()).toContain('ЕВРОСТРОЙ 21 ЕООД'); // the winner heads the block
    expect(text().toLowerCase()).toContain('декларирало дял на свързано лице'); // family label
    // each detail block heads by the company with a link to its spending profile + its ЕИК
    const block = container.querySelector('.person-time-company')!;
    const profile = block.querySelector('a[href="/companies/333"]');
    expect(profile).not.toBeNull();
    expect(container.querySelector('[id=holdings]')).toBeNull();
    // the official is the page's subject (PageHeader) and is NOT repeated as a link inside a block
    expect(block.textContent).not.toContain('Кмет Тестов');
  });

  it('keeps the timeline visible and sends company contracts to the one common list', async () => {
    const l = link({ linkKey: 'k1', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' });
    await mount(Person as never, {
      official: 'Кмет Тестов',
      links: [l],
      contracts: {
        // keyed by ЕИК; temporal is derived per link from the window (2019–2023): 2021 → in, 2016 → before.
        '333': [
          contract({ authority: 'Община Пловдив', signedAt: '2021-05-01' }),
          contract({
            contractSlug: 'e:out',
            contractNumber: 'Д-2',
            authority: 'Община Стара',
            signedAt: '2016-01-01',
          }),
        ],
      },
    });
    const t = text();
    expect(t).toContain('Участия и договори');
    expect(t).toContain('Договори по свързаните дружества');
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain(
      '/x?company=333&basis=matched&year=2021#contract-filters',
    );
    expect(container.querySelector('.person-time-company a[href*="/contracts/"]')).toBeNull();
    expect(t).not.toContain('Дял при възложителите');
    expect(container.querySelector('.cc-toggle')).toBeNull();
  });

  it('a family-only page never asserts the official owns the stake (§2.6)', async () => {
    // The block labels are family-aware; the page lede + section hint must not read „собствен дял" above a
    // block that correctly says „свързано лице".
    await mount(Person as never, {
      official: 'Кмет Тестов',
      links: [
        link({ linkKey: 'k1', relation: 'related', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' }),
      ],
      contracts: {},
    });
    expect(container.querySelector('#declared-overview')?.textContent).not.toContain(
      'собствен дял',
    );
    const overview = container.querySelector('#declared-overview')!.closest('section')!;
    expect(overview.textContent).not.toContain('собствен дял');
    expect(overview.textContent).toContain('декларирало дял на свързано лице');
  });

  it('an own-stake page still says so — the wording is family-AWARE, not family-blind', async () => {
    // POSITIVE CONTROL. Removing the claim everywhere would satisfy the assertion above while making the
    // page vaguer than the data warrants: a self stake IS the official's own and should read that way.
    await mount(Person as never, {
      official: 'Кмет Тестов',
      links: [link({ linkKey: 'k1', relation: 'owns', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' })],
      contracts: {},
    });
    expect(text()).toContain('собствен дял');
  });

  it('preserves the ADR-0032 callout wording — деклариран дял, собствен или на свързано лице', async () => {
    await mount(Person as never, {
      official: 'Кмет Тестов',
      links: [link({ linkKey: 'k1', relation: 'owns', eik: '333' })],
      contracts: {},
    });
    const t = text();
    expect(t).toContain('Декларирани интереси');
    expect(t).toContain('декларирало собствен дял');
    expect(t).toContain('без името на близкия');
  });

  it('meta() names the person in the title and marks the page noindex', () => {
    const tags = personMeta({
      data: { name: 'ИВАН ПЕТРОВ', links: [], contracts: {} },
      matches: [],
      params: { id: 'aXZhbg' },
    } as never);
    expect(JSON.stringify(tags)).toContain('Иван Петров');
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });

  it('meta() falls back to a generic noun when the loader data is absent (error boundary render)', () => {
    // On a thrown 404 the route still renders its meta with `data` undefined; the title must degrade to
    // the generic noun rather than interpolating "undefined" into a public page title.
    const tags = personMeta({ data: undefined, matches: [], params: { id: 'aXZhbg' } } as never);
    expect(JSON.stringify(tags)).toContain('Лице');
    expect(JSON.stringify(tags)).not.toContain('undefined');
  });

  it('falls back to a generic kicker when the person has no institution on the first link', async () => {
    await mount(Person as never, {
      official: 'Иван Петров',
      links: [], // no links → links[0] is undefined → the kicker takes its fallback
    });
    expect(text()).toContain('Длъжностно лице');
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
    // rung 2 — all three names, one registered person, and the two refusals
    expect(t).toContain('пълно съвпадение и на трите имена');
    expect(t).toContain('едно и също вписано лице');
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
