// @vitest-environment jsdom
// The /conflicts table cells for rows shaped by the loader contract rather than by groupByPerson: a row may
// carry only its sole company (no company list) and only the official's role line (no declared institutions).
// Each company still says whose stake it is — own, a relative's, or both — without naming the relative.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictPersonRow } from '../lib/conflicts';
import Conflicts from './conflicts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<ConflictPersonRow>): ConflictPersonRow => ({
  official: 'ИВАН ПЕТРОВ',
  officialSlug: 'aXZhbg',
  institution: null,
  position: null,
  companyCount: 1,
  soleCompany: { company: 'АЛФА ООД', eik: '111111111' },
  contractCount: 2,
  contractValueEur: 1_000,
  contemporaneousValueEur: 500,
  stakeKind: 'self',
  ownInstitution: false,
  hasContemporaneous: true,
  ...over,
});

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

async function mount(pageRows: ConflictPersonRow[], nav = { page: 1, pageCount: 1 }, url = '') {
  const loaderData = {
    authority: null,
    facets: { self: 0, family: 0, own: 0, window: 0, institutions: [] },
    ...nav,
    total: pageRows.length,
    available: pageRows.length,
    pageRows,
  };
  const Stub = createRoutesStub([
    { path: '/conflicts', Component: Conflicts, loader: () => loaderData },
    { path: '/persons/:id', Component: () => null },
    { path: '/companies/:eik', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[`/conflicts${url}`]} />);
  });
}

const bodyRows = () => [...container.querySelectorAll('tbody tr')];
const cell = (tr: Element, label: string) => tr.querySelector(`td[data-label="${label}"]`)!;

describe('/conflicts — a row with only its sole company', () => {
  it('names and links the company, and marks a relative’s stake — alone or beside an own one', async () => {
    await mount([
      row({ officialSlug: 'own', stakeKind: 'self' }),
      row({
        officialSlug: 'family',
        stakeKind: 'family',
        soleCompany: { company: 'БЕТА ЕООД', eik: '222222222' },
      }),
      row({
        officialSlug: 'mixed',
        stakeKind: 'mixed',
        soleCompany: { company: 'ГАМА АД', eik: '333333333' },
      }),
    ]);
    const companies = bodyRows().map((tr) => cell(tr, 'Дружества'));
    expect(companies.map((td) => td.querySelector('a')?.getAttribute('href'))).toEqual([
      '/companies/111111111',
      '/companies/222222222',
      '/companies/333333333',
    ]);
    expect(companies.map((td) => td.querySelector('.chip')?.textContent ?? null)).toEqual([
      null,
      'дял на свързано лице',
      'собствен и свързан дял',
    ]);
    // The relationship is never asserted in the rows (the callout above the table names it only to rule it out).
    expect(container.querySelector('tbody')?.textContent).not.toMatch(/съпруг|дете/);
  });

  it('leaves the cell empty when the row names no company at all', async () => {
    await mount([row({ companyCount: 2, soleCompany: null })]);
    const td = cell(bodyRows()[0]!, 'Дружества');
    expect(td.querySelectorAll('li')).toHaveLength(0);
    expect(td.textContent).toBe('');
  });
});

describe('/conflicts — a row without declared institutions', () => {
  it('shows the official’s position and institution under the name instead', async () => {
    await mount([row({ position: 'Кмет', institution: 'Община Тест' })]);
    const title = cell(bodyRows()[0]!, 'Длъжностно лице');
    expect(title.querySelector('a')?.textContent).toBe('Иван Петров');
    expect(title.querySelector('.small.muted')?.textContent).toBe('Кмет · Община Тест');
    expect(title.textContent).not.toContain('Институции в декларациите');
  });

  it('shows the name alone when neither is on record', async () => {
    await mount([row({ declaredInstitutions: [] })]);
    const title = cell(bodyRows()[0]!, 'Длъжностно лице');
    expect(title.textContent).toBe('Иван Петров');
  });
});

describe('/conflicts — the second page', () => {
  it('continues the ranks and links back to the first page', async () => {
    await mount([row({})], { page: 2, pageCount: 2 }, '?page=2&sort=total');
    expect(cell(bodyRows()[0]!, '№').textContent).toBe('101');
    const prev = container.querySelector('nav.paging a[rel="prev"]');
    expect(prev?.getAttribute('href')).toBe('/conflicts?sort=total&page=1');
    expect(container.querySelector('nav.paging a[rel="next"]')).toBeNull();
  });
});
