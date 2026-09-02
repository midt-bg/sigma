// @vitest-environment jsdom
// Deep render tests for the per-entity conflict pages (official, company) and the static methodology page.
// Each is mounted as a real route through createRoutesStub so ConflictDetail/Link resolve, and the
// assertions check the ADR-0032 surface: an office-holder page heads each block by the winning company and
// never repeats the office-holder inside a block, a company page mirrors, and the methodology page states
// the three libel rails in plain language. Since #287 the rich detail (per-company/per-official breakdown
// with ЕИК + profile link, timeline, „Дял при възложителите", contract split) is rendered EAGERLY here —
// no expand click — because the /conflicts list is now a lean one-row-per-person table.
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictContract, ConflictLink } from '@sigma/api-contract';
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
  it('heads each block by the winning company (ЕИК + profile link), never repeats the official inside', async () => {
    const l = link({
      linkKey: 'k1',
      relation: 'related',
      company: 'ЕВРОСТРОЙ 21 ЕООД',
      eik: '333',
      ownInstitution: false,
    });
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [l],
      contracts: { '333': [contract({ authority: 'Община Тест' })] }, // keyed by ЕИК (#312 HIGH 1)
    });
    expect(text()).toContain('Кмет Тестов'); // page header names the official
    expect(text()).toContain('ЕВРОСТРОЙ 21 ЕООД'); // the winner heads the block
    expect(text()).toContain('деклариран дял на свързано лице'); // family label
    // each detail block heads by the company with a link to its spending profile + its ЕИК
    const block = container.querySelector('.conflict-detail')!;
    const profile = block.querySelector('a[href="/companies/333"]');
    expect(profile).not.toBeNull();
    expect(block.textContent).toContain('ЕИК'); // ЕИК sub-label present in the block
    expect(block.textContent).toContain('333');
    // the official is the page's subject (PageHeader) and is NOT repeated as a link inside a block
    expect(block.textContent).not.toContain('Кмет Тестов');
  });

  it('renders the rich detail EAGERLY — timeline, per-authority shares, contract split — no expand click', async () => {
    const l = link({ linkKey: 'k1', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' });
    await mount(ConflictOfficial as never, {
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
    // timeline heading + the per-authority share section, both from the eagerly-loaded contracts
    expect(t).toContain('Времева ос');
    expect(t).toContain('Дял при възложителите');
    // contracts split in/out the declared period — the in-window heading is present with no toggle
    expect(t).toContain('Договори, сключени в декларирания период');
    expect(t).toContain('Извън периода');
    // no expand affordance survives — the detail is inlined, not behind a „Виж договорите" button
    expect(container.querySelector('.cc-toggle')).toBeNull();
    expect(t).not.toContain('Виж договорите');
    // a contract is actually listed (its number links to the contract page)
    expect(container.querySelector('a[href*="/contracts/"]')).not.toBeNull();
  });

  it('a family-only page never asserts the official owns the stake (§2.6)', async () => {
    // The block labels are family-aware; the page lede + section hint must not read „собствен дял" above a
    // block that correctly says „свързано лице".
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [
        link({ linkKey: 'k1', relation: 'related', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' }),
      ],
      contracts: {},
    });
    expect(text()).not.toContain('собствен дял');
    expect(text()).toContain('деклариран дял на свързано лице');
  });

  it('an own-stake page still says so — the wording is family-AWARE, not family-blind', async () => {
    // POSITIVE CONTROL. Removing the claim everywhere would satisfy the assertion above while making the
    // page vaguer than the data warrants: a self stake IS the official's own and should read that way.
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [link({ linkKey: 'k1', relation: 'owns', company: 'ЕВРОСТРОЙ 21 ЕООД', eik: '333' })],
      contracts: {},
    });
    expect(text()).toContain('собствен дял');
  });

  it('preserves the ADR-0032 callout wording — деклариран дял, собствен или на свързано лице', async () => {
    await mount(ConflictOfficial as never, {
      official: 'Кмет Тестов',
      links: [link({ linkKey: 'k1', relation: 'owns', eik: '333' })],
      contracts: {},
    });
    const t = text();
    expect(t).toContain('Източник и обхват'); // the callout heading is preserved
    expect(t).toContain('деклариран дял — собствен или на свързано лице'); // corrected ADR-0032 copy
    expect(t).toContain('името на близкия не се показва'); // relative never named
  });

  it('meta() names the person in the title and marks the page noindex', () => {
    const tags = officialMeta({
      data: { official: 'Иван Петров', links: [], contracts: {} },
      matches: [],
      params: { id: 'aXZhbg' },
    } as never);
    expect(JSON.stringify(tags)).toContain('Иван Петров');
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });
});

describe('Trade Register evidence on the detail page (#279, ADR-0033)', () => {
  // The registry-fact rung moved from the retired list card to ConflictDetail (#287). These render guards are
  // ported 1:1 from the deleted card tests: the evidence label is a defamation-critical mapping — its failure
  // mode is a false, NAMED claim that the register records this person as owner — so a unit test of
  // registryEvidenceLabel is not enough; what the COMPONENT renders must be pinned (niki #312 HIGH 1).
  const official = 'Кмет Тестов';

  it('renders the registry fact the link rests on, so the block explains itself', async () => {
    await mount(ConflictOfficial as never, {
      official,
      links: [link({ linkKey: 'k1', evidenceKind: 'document', registryRole: 'owner' })],
      contracts: {},
    });
    const t = text();
    expect(t).toContain('Регистър');
    expect(t).toContain('лицето е вписано като съдружник/собственик');
    expect(t).toContain('вписване 2011-05-02'); // WHICH entry
    expect(t).toContain('справка 2026-08-05'); // and HOW FRESH it is
    // The entry NUMBER is what makes the claim findable in the register — a date alone does not identify a record.
    expect(t).toContain('20110502101007');
  });

  it('omits the entry number rather than printing an empty „· №" when there is none', async () => {
    // POSITIVE CONTROL for the row's shape: a confirmed link (seat/ЕИК) has no act entry to cite, so the label
    // must be absent entirely — not „· №" with nothing after it, which reads as missing data.
    await mount(ConflictOfficial as never, {
      official,
      links: [
        link({
          linkKey: 'k1',
          evidenceKind: 'confirmed',
          registryRole: null,
          registryEntryNumber: null,
        }),
      ],
      contracts: {},
    });
    const t = text();
    expect(t).toContain('Регистър');
    expect(t).not.toContain('· №');
  });

  it('a seat/ЕИК confirmation never implies somebody was found in the act', async () => {
    await mount(ConflictOfficial as never, {
      official,
      links: [link({ linkKey: 'k1', evidenceKind: 'confirmed', registryRole: null })],
      contracts: {},
    });
    const t = text();
    expect(t).toContain('самоличност, потвърдена по декларирани данни');
    expect(t).not.toContain('вписано като');
  });

  it('a FAMILY block never carries a registry-role claim — the relative is not in the act we read', async () => {
    // A relative's stake is registered to the RELATIVE, so `findPerson` never finds the official and the rung
    // can only be confirmed/registryRole:null. „вписано като съдружник/собственик" here would assert that the
    // named official is recorded as an owner of this company — a false, named, libel-shaped claim on the one
    // block whose whole design keeps the stakeholder anonymous (ADR-0030/0032).
    await mount(ConflictOfficial as never, {
      official,
      links: [
        link({
          linkKey: 'k1',
          relation: 'related',
          evidenceKind: 'confirmed',
          registryRole: null,
          registryEntryNumber: null,
        }),
      ],
      contracts: {},
    });
    const block = container.querySelector('.conflict-detail')!;
    expect(block.textContent).toContain('деклариран дял на свързано лице');
    expect(block.textContent).toContain('самоличност, потвърдена по декларирани данни');
    expect(block.textContent).not.toContain('вписано като');
  });

  it('links out to the register so a reader can check the same act we read', async () => {
    await mount(ConflictOfficial as never, {
      official,
      links: [link({ linkKey: 'k1', eik: '201122335' })],
      contracts: {},
    });
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => h.includes('201122335'))).toBe(true);
  });
});

describe('/conflicts/company/:eik — render', () => {
  it('heads each block by the official (institution sub-label + profile link), never repeats the company inside', async () => {
    await mount(ConflictCompany as never, {
      company: 'ТРЕЙС ГРУП ХОЛД АД',
      eik: '111',
      links: [
        link({ linkKey: 'k1' }),
        link({
          linkKey: 'k2',
          officialSlug: 's2',
          official: 'Втори Официал',
          institution: 'Община Друга',
        }),
      ],
      // both officials share ЕИК 111 → ONE contracts entry keyed by ЕИК, shared by both blocks (#312 HIGH 1)
      contracts: { '111': [contract()] },
    });
    expect(text()).toContain('ТРЕЙС ГРУП ХОЛД АД');
    expect(text()).toContain('111'); // ЕИК in the header
    expect(text()).toContain('Иван Петров'); // an official heads a block
    expect(text()).toContain('Втори Официал');
    const block = container.querySelector('.conflict-detail')!;
    // block heads by the official, linking to their conflicts page, with the institution sub-label
    expect(block.querySelector('a[href="/conflicts/official/aXZhbg"]')).not.toBeNull();
    expect(block.textContent).toContain('Община Тест'); // institution sub-label
    // the company is the page's subject (PageHeader) and is NOT repeated inside a block
    expect(block.textContent).not.toContain('ТРЕЙС ГРУП ХОЛД АД');
  });

  it('renders the rich detail EAGERLY — timeline, per-authority shares, contract split — no expand click', async () => {
    await mount(ConflictCompany as never, {
      company: 'ТРЕЙС ГРУП ХОЛД АД',
      eik: '111',
      links: [link({ linkKey: 'k1' })],
      contracts: {
        // keyed by ЕИК; temporal derived per link (window 2019–2023): 2021 → in-window, 2016 → before.
        '111': [
          contract({ authority: 'Община Пловдив', signedAt: '2021-05-01' }),
          contract({
            contractSlug: 'e:out',
            contractNumber: 'Д-2',
            signedAt: '2016-01-01',
          }),
        ],
      },
    });
    const t = text();
    expect(t).toContain('Времева ос');
    expect(t).toContain('Дял при възложителите');
    expect(t).toContain('Договори, сключени в декларирания период');
    expect(t).toContain('Извън периода');
    expect(container.querySelector('.cc-toggle')).toBeNull();
    expect(t).not.toContain('Виж договорите');
  });

  it('meta() names the company and marks the page noindex', () => {
    const tags = companyMeta({
      data: { company: 'ТРЕЙС ГРУП ХОЛД АД', eik: '111', links: [], contracts: {} },
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
