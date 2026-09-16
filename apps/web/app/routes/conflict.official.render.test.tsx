// @vitest-environment jsdom
// The two /conflicts/official/:id views that are not a profile: the list of profiles an earlier id was carried
// into, and a person's source archive. Both name a person, so both keep the page title honest.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { PersonDeclaration } from '@sigma/api-contract';
import { personSlug } from '@sigma/db';
import ConflictOfficial, { meta } from './conflict.official';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const declaration: PersonDeclaration = {
  id: 'd1',
  year: '2023',
  template: 'assets',
  type: 'Annualy',
  declaredOn: null,
  submittedOn: '2024-05-15',
  institution: 'Община Русе',
  position: 'Общински съветник',
  url: 'https://register.cacbg.bg/2023/d1.xml',
  companyEiks: [],
};
const source = { name: 'ИВАН ПЕТРОВ', declarations: [declaration] };
const destinations = [
  {
    id: 'person:merged',
    name: 'ИВАН ПЕТРОВ',
    kind: 'person' as const,
    declaration_count: 1,
    institutions: 'Община Русе',
  },
  {
    id: 'person:source',
    name: 'Иван Петров',
    kind: 'source' as const,
    declaration_count: 3,
    institutions: null,
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
    { path: '/conflicts/official/:id', Component: ConflictOfficial, loader: () => loaderData },
    { path: '/companies/:eik', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/conflicts/official/aXZhbg']} />);
  });
}

describe('/conflicts/official/:id — profiles an earlier id was carried into', () => {
  it('lists each profile with a link to it, its kind and how many documents it holds', async () => {
    await mount({ destinations });
    expect(container.querySelector('.kicker')?.textContent).toBe('Длъжностни лица');
    expect(container.querySelector('h1')?.textContent).toBe('Профили и декларации');
    const items = [...container.querySelectorAll('main li')];
    expect(items).toHaveLength(2);

    const [merged, unconfirmed] = items as [HTMLLIElement, HTMLLIElement];
    const link = merged.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(
      `/conflicts/official/${personSlug('person:merged')}?view=profile`,
    );
    expect(link.textContent).toBe('Иван Петров');
    const [kind, institutions] = [...merged.querySelectorAll('p')].map((p) => p.textContent);
    expect(kind).toBe('Обединен профил · 1 декларация');
    expect(institutions).toBe('Община Русе');

    expect(unconfirmed.querySelector('a')?.getAttribute('href')).toBe(
      `/conflicts/official/${personSlug('person:source')}?view=profile`,
    );
    // No institution on record → no empty paragraph for it.
    expect([...unconfirmed.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Декларации с непотвърдена принадлежност · 3 декларации',
    ]);
  });
});

describe('/conflicts/official/:id — source archive', () => {
  it('shows the documents under the declarant’s name, as a separate source record', async () => {
    await mount({ source });
    expect(container.querySelector('.kicker')?.textContent).toBe('Декларации от източника');
    expect(container.querySelector('h1')?.textContent).toBe('Иван Петров');
    expect(container.textContent).toContain(
      'Документите са запазени като отделен източников запис.',
    );
    expect(container.querySelector('#declarations')?.textContent).toBe('Всички декларации');
    expect(container.querySelector(`a[href="${declaration.url}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain('Профили и декларации');
  });
});

describe('/conflicts/official/:id — meta', () => {
  const titleOf = (data: unknown) =>
    meta({ data, matches: [], params: { id: 'aXZhbg' } } as never).find(
      (t): t is { title: string } => 'title' in t,
    )?.title;

  it('names the declarant of a source archive in the title', () => {
    expect(titleOf({ source })).toBe('Иван Петров — СИГМА');
  });

  it('keeps the generic title for the list of profiles and for an empty archive', () => {
    expect(titleOf({ destinations })).toBe('Длъжностно лице — СИГМА');
    expect(titleOf({ source: null })).toBe('Длъжностно лице — СИГМА');
  });
});
