// @vitest-environment jsdom
// The /conflicts filter column, the scope line over the table and the empty state, rendered through a real
// data router so the links and the URL state resolve as on the site.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import {
  conflictFacets,
  conflictListFilters,
  listConflictPeople,
  type ConflictPersonRow,
} from '../lib/conflicts';
import Conflicts from './conflicts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (over: Partial<ConflictPersonRow>): ConflictPersonRow => ({
  official: 'Лице Тестово',
  officialSlug: 'x',
  institution: null,
  position: null,
  companyCount: 1,
  companies: [{ company: 'ТЕСТ ГРУП ЕООД', eik: '111', self: 1, family: 0 }],
  soleCompany: null,
  contractCount: 2,
  contractValueEur: 1_000,
  contemporaneousValueEur: null,
  stakeKind: 'self',
  ownInstitution: false,
  hasContemporaneous: false,
  declaredInstitutions: [{ institution: 'Община Тест', positions: ['Съветник'], years: ['2021'] }],
  ...over,
});

const everyone = [
  row({
    officialSlug: 'in',
    official: 'Периодна Тестова',
    hasContemporaneous: true,
    contemporaneousValueEur: 500,
  }),
  row({ officialSlug: 'out', official: 'Извънпериодна Тестова', stakeKind: 'family' }),
  row({
    officialSlug: 'seat',
    official: 'Членова Тестова',
    stakeKind: 'registry',
    hasContemporaneous: true,
    companies: [
      { company: 'ТЕСТ АД', eik: '222', self: 0, family: 0, registry: 1, registryRole: 'board' },
    ],
    direct: null,
  }),
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

async function render(url: string, people: ConflictPersonRow[] = everyone) {
  const Stub = createRoutesStub([
    {
      path: '/conflicts',
      Component: Conflicts,
      loader: ({ request }) => {
        const filters = conflictListFilters(new URL(request.url).searchParams);
        const rows = listConflictPeople(people, filters);
        return {
          authority: null,
          page: 1,
          pageCount: 1,
          total: rows.length,
          available: people.length,
          pageRows: rows,
          facets: conflictFacets(people, filters),
        };
      },
    },
    { path: '/persons/:id', Component: () => null },
    { path: '/companies/:eik', Component: () => null },
    { path: '/conflicts/methodology', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

const text = () => container.textContent ?? '';
const names = () =>
  [...container.querySelectorAll('tbody tr')].map((r) => r.querySelector('a')?.textContent);

it('puts every control in the filter column, in one form, with the scope boxes off by default', async () => {
  await render('/conflicts');
  const rail = container.querySelector('aside.filter-rail')!;
  const groups = [...rail.querySelectorAll('details.filter-group')].map((d) =>
    d.getAttribute('aria-label'),
  );
  expect(groups).toEqual([
    'Обхват на списъка',
    'Източник на връзката',
    'Възложител на договорите',
    'Институция на лицето',
  ]);
  // Real inputs inside labels: reachable and operable by keyboard.
  const scope = rail.querySelector('details[aria-label="Обхват на списъка"]')!;
  const boxes = [...scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((b) => [b.name, b.value, b.checked])).toEqual([
    ['include', 'outside', false],
    ['include', 'boards', false],
  ]);
  expect(scope.textContent).toContain(
    'Периодът обхваща годините с налични декларации за съответната публична длъжност.',
  );
  const source = rail.querySelector('details[aria-label="Източник на връзката"]')!;
  expect([...source.querySelectorAll('label')].map((l) => l.textContent!.trim())).toEqual([
    'всички източници1',
    'декларация за собствено участие1',
    'декларация за дял на свързано лице0',
    'само вписване в Търговския регистър0',
  ]);
  const buyer = rail.querySelector('details[aria-label="Възложител на договорите"]')!;
  expect([...buyer.querySelectorAll('label')].map((l) => l.textContent!.trim())).toEqual([
    'всички институции1',
    'собствената институция на лицето0',
  ]);
  // Only search, count, sorting and the scope line stand over the table.
  expect(container.querySelector('#results .conflicts-scope')!.textContent).toBe(
    'Обхват: Собственост или управление с договори в периода на длъжността, в който връзката е декларирана или вписана.',
  );
  expect(names()).toEqual(['Периодна Тестова']);
});

it('marks a widened scope in the boxes and in the scope line', async () => {
  await render('/conflicts?include=outside&include=boards');
  const checked = [
    ...container.querySelectorAll<HTMLInputElement>('input[name="include"]:checked'),
  ].map((b) => b.value);
  expect(checked).toEqual(['outside', 'boards']);
  expect(container.querySelector('.conflicts-scope')!.textContent).toContain(
    'членство в управителен орган — със или без договори',
  );
  expect(names()).toHaveLength(3);
});

it('offers on an empty list the wider scopes that would fill it, keeping every other filter', async () => {
  await render('/conflicts?source=family&sort=total&q=тестова');
  expect(container.querySelector('table')).toBeNull();
  expect(text()).toContain('Няма лица за избраните филтри.');
  const widen = [...container.querySelectorAll('.conflicts-widen a')];
  // Only the box that finds someone is offered; the seats find nobody with a relative's stake.
  expect(widen.map((a) => a.textContent)).toEqual([
    'Включи и връзки без договори в периода на длъжността',
  ]);
  const href = new URL(widen[0]!.getAttribute('href')!, 'https://sigma.test');
  expect(href.pathname).toBe('/conflicts');
  expect(Object.fromEntries(href.searchParams)).toEqual({
    q: 'тестова',
    source: 'family',
    include: 'outside',
    sort: 'total',
  });
  expect(container.querySelector('.conflicts-widen')!.textContent).toContain('1 лице');
  expect(text()).toContain('Изчисти филтрите');
});

it('offers both boxes together only when that finds more than either alone', async () => {
  // The seat is in the period, the relative's stake outside it: either box alone adds one person.
  await render('/conflicts?source=registry');
  expect([...container.querySelectorAll('.conflicts-widen a')].map((a) => a.textContent)).toEqual([
    'Включи и членство в управителни органи',
  ]);
});

const company = (eik: string, inPeriod: number, periodKnown: number) => ({
  company: `ТЕСТ ${eik} ЕООД`,
  eik,
  self: 1,
  family: 0,
  inPeriod,
  periodKnown,
});
const companyCell = (name: string) =>
  [...container.querySelectorAll('tbody tr')]
    .find((r) => r.textContent?.includes(name))!
    .querySelector('td[data-label="Дружества"]')!;
const companyItem = (name: string, eik: string) =>
  [...companyCell(name).querySelectorAll('li')].find((li) =>
    li.textContent?.includes(`ТЕСТ ${eik} ЕООД`),
  )!;

it('says in words beside a company when its period cannot be established', async () => {
  await render('/conflicts?include=outside', [
    row({
      officialSlug: 'unknown',
      official: 'Неустановена Тестова',
      companies: [company('701', 0, 0)],
    }),
    row({
      officialSlug: 'known',
      official: 'Периодна Тестова',
      hasContemporaneous: true,
      contemporaneousValueEur: 500,
      companies: [company('702', 1, 1)],
    }),
  ]);
  expect(companyItem('Неустановена Тестова', '701').textContent).toContain(
    'периодът не е установен',
  );
  expect(companyItem('Неустановена Тестова', '701').querySelector('.chip')).not.toBeNull();
  expect(companyCell('Периодна Тестова').textContent).not.toContain('периодът не е установен');
});

it('labels the other companies of a listed person as having no contract in the period', async () => {
  // The person qualifies through one company; the other one is still listed and its contracts are in the
  // all-years figures, so it says it has none inside the period rather than reading as part of it.
  await render('/conflicts', [
    row({
      officialSlug: 'two',
      official: 'Двуфирмена Тестова',
      hasContemporaneous: true,
      contemporaneousValueEur: 500,
      companyCount: 2,
      companies: [company('801', 1, 1), company('802', 0, 1)],
    }),
  ]);
  expect(companyItem('Двуфирмена Тестова', '801').textContent).not.toContain('без договори');
  expect(companyItem('Двуфирмена Тестова', '802').textContent).toContain(
    'без договори в периода на длъжността',
  );
});
