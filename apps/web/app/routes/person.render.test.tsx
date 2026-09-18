// @vitest-environment jsdom
// The /persons/:id page as a reader gets it: the combined profile when there is one, otherwise the Trade
// Register's source records one per company — never a profile stitched from records that may not be the same
// person. Both views name a person, so the page stays out of search indices (meta and header alike).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import Person, { headers, meta } from './person';
import { emptyActivity } from '../lib/person-profile.test-support';
import type { LoadedPersonProfile } from '../lib/person-profile.server';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = 'a'.repeat(64);

const profile: LoadedPersonProfile = {
  person: {
    slug: HASH,
    name: 'АННА ПЕТРОВА',
    roles: [],
    companies: 0,
    wonEur: 0,
    asOf: null,
    network: { center: null, nodes: [], edges: [], omitted: 0 },
  },
  name: 'АННА ПЕТРОВА',
  links: [],
  timeline: { contracts: [], observations: [], reads: [], buyers: [], institutionProfiles: [] },
  declarations: [],
  activity: emptyActivity,
  totals: { companies: 0, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
  tieLayout: null,
  aliases: [],
  relatives: [],
  namedBy: [],
};

const sources = [
  {
    eik: '111111111',
    name: 'ИВАН ПЕТРОВ',
    company: 'АЛФА ООД',
    href: '/companies/111111111',
    fetchedAt: '2026-09-10T03:00:00Z',
  },
  {
    eik: '222222222',
    name: 'ИВАН ПЕТРОВ',
    company: 'БЕТА ЕООД',
    href: null,
    fetchedAt: '2026-08-01T03:00:00Z',
  },
];

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

async function mount(loaderData: unknown) {
  const Stub = createRoutesStub([
    { path: '/persons/:id', Component: Person, loader: () => loaderData },
    { path: '/companies/:eik', Component: () => null },
    { path: '/conflicts/methodology', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[`/persons/${HASH}`]} />);
  });
}

const rows = () => [...container.querySelectorAll('tbody tr')];
const cell = (row: Element, label: string) => row.querySelector(`td[data-label="${label}"]`)!;

describe('/persons/:id — source records', () => {
  it('lists each register record under its company, without combining them into a profile', async () => {
    await mount({ sources });
    expect(container.querySelector('.kicker')?.textContent).toBe('Търговски регистър');
    expect(container.querySelector('h1')?.textContent).toBe('Източникови записи');
    expect(container.textContent).toContain(
      'Наличните сведения не са достатъчни за обединяване в общ профил.',
    );
    expect(rows()).toHaveLength(2);
    expect(cell(rows()[0]!, 'Име в регистъра').textContent).toBe('Иван Петров');
    expect(cell(rows()[0]!, 'Извлечено на').textContent).toBe('10.09.2026');
    expect(cell(rows()[1]!, 'Извлечено на').textContent).toBe('01.08.2026');
    expect(container.textContent).toContain('Официален източник: Агенция по вписванията');
    expect(container.querySelector('.profile-nav')).toBeNull();
  });

  it('links a company only when it has a profile', async () => {
    await mount({ sources });
    const linked = cell(rows()[0]!, 'Дружество').querySelector('a');
    expect(linked?.getAttribute('href')).toBe('/companies/111111111');
    expect(linked?.textContent).toBe('АЛФА ООД');
    const bare = cell(rows()[1]!, 'Дружество');
    expect(bare.querySelector('a')).toBeNull();
    expect(bare.textContent).toBe('БЕТА ЕООД');
  });

  it('opens each record’s own register entry in a new tab', async () => {
    await mount({ sources });
    const a = cell(rows()[1]!, 'Партида').querySelector('a')!;
    expect(a.getAttribute('href')).toBe(
      'https://portal.registryagency.bg/CR/bg/Reports/ActiveConditionTabResult?uic=222222222',
    );
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('ЕИК 222222222 (в нов раздел)');
  });
});

describe('/persons/:id — archived declarations', () => {
  it('renders a standalone source archive without presenting it as a combined profile', async () => {
    await mount({
      source: {
        name: 'ИВАН ПЕТРОВ ТЕСТОВ',
        declarations: [
          {
            id: 'test-declaration',
            year: '2025',
            template: 'interests',
            type: 'Annual',
            declaredOn: '2026-03-01',
            submittedOn: '2026-03-02',
            institution: 'Община Тестово',
            position: 'Тестова длъжност',
            url: 'https://register.cacbg.bg/test-declaration.xml',
            companyEiks: [],
          },
        ],
      },
    });

    expect(container.querySelector('.kicker')?.textContent).toBe('Декларации от източника');
    expect(container.querySelector('h1')?.textContent).toBe('Иван Петров Тестов');
    expect(container.querySelector('#declarations')?.textContent).toContain('Всички декларации');
    expect(container.querySelector('#declaration-test-declaration')).not.toBeNull();
    expect(container.querySelector('.profile-nav')).toBeNull();
  });
});

describe('/persons/:id — split destinations', () => {
  it('lists each destination with its kind, declaration count and available institutions', async () => {
    await mount({
      destinations: [
        {
          id: 'person:test-profile',
          kind: 'person',
          name: 'Иван Петров Тестов',
          declaration_count: 1,
          institutions: 'Община Тестово',
        },
        {
          id: 'source:test-archive',
          kind: 'source',
          name: 'Иван Петров Тестов — архив',
          declaration_count: 2,
          institutions: null,
        },
      ],
    });

    expect(container.querySelector('.kicker')?.textContent).toBe('Длъжностни лица');
    expect(container.querySelector('h1')?.textContent).toBe('Профили и декларации');
    const rows = [...container.querySelectorAll('main li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Обединен профил · 1 декларация');
    expect(rows[0]!.textContent).toContain('Община Тестово');
    expect(rows[1]!.textContent).toContain(
      'Декларации с непотвърдена принадлежност · 2 декларации',
    );
    expect(rows[1]!.querySelectorAll('p')).toHaveLength(1);
    for (const row of rows) {
      expect(row.querySelector('a')?.getAttribute('href')).toMatch(/\?view=profile$/);
    }
  });
});

describe('/persons/:id — profile', () => {
  it('renders the combined profile under the person’s name', async () => {
    await mount(profile);
    expect(container.querySelector('h1')?.textContent).toBe('Анна Петрова');
    expect(container.querySelector('.kicker')?.textContent).toBe('Лице · Търговски регистър');
    expect(container.textContent).not.toContain('Източникови записи');
  });
});

describe('/persons/:id — meta and headers', () => {
  const titleOf = (tags: ReturnType<typeof meta>) =>
    tags.find((t): t is { title: string } => 'title' in t)?.title;

  it('titles the page with the person’s name and keeps it out of search indices', () => {
    const tags = meta({ data: profile, params: { id: HASH }, matches: [] } as never);
    expect(titleOf(tags)).toBe('Анна Петрова — СИГМА');
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });

  it('falls back to a generic title for the source records and for an error render', () => {
    for (const data of [{ sources }, undefined]) {
      const tags = meta({ data, params: { id: HASH }, matches: [] } as never);
      expect(titleOf(tags)).toBe('Лице — СИГМА');
      expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
    }
  });

  it('titles a standalone declaration archive with its source name', () => {
    const tags = meta({
      data: { source: { name: 'ИВАН ПЕТРОВ ТЕСТОВ' } },
      params: { id: HASH },
      matches: [],
    } as never);
    expect(titleOf(tags)).toBe('Иван Петров Тестов — СИГМА');
  });

  it('points the canonical link at the person’s address when the origin is known', () => {
    const tags = meta({
      data: profile,
      params: { id: HASH },
      matches: [{ id: 'root', data: { origin: 'https://sigma.test' } }],
    } as never);
    expect(tags).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: `https://sigma.test/persons/${HASH}`,
    });
    expect(tags).toContainEqual({
      property: 'og:url',
      content: `https://sigma.test/persons/${HASH}`,
    });
  });

  it('caches the page for an hour at the edge and marks the response noindex', () => {
    // The page's policy does not depend on the loader's headers.
    const h = (headers as (args?: unknown) => Headers)({ loaderHeaders: new Headers() });
    expect(h.get('Cache-Control')).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
    expect(h.get('X-Robots-Tag')).toBe('noindex');
  });
});
