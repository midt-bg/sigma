// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import type { ConflictLink } from '@sigma/api-contract';
import { CompanyDeclarants } from './CompanyDeclarants';
const link = (officialSlug: string, institution: string, year: string): ConflictLink => ({
  linkKey: `${officialSlug}|123456789|family`,
  officialSlug,
  official: 'ИВАН ПЕТРОВ ТЕСТОВ',
  institution,
  position: 'Главен архитект',
  company: 'ТЕСТ ООД',
  eik: '123456789',
  relation: 'related',
  contemporaneous: true,
  ownInstitution: false,
  firstDeclaredYear: year,
  lastDeclaredYear: year,
  contractCount: 11,
  contractValueEur: 500,
  contemporaneousContractCount: 1,
  contemporaneousValueEur: 100,
  firstContractYear: '2020',
  lastContractYear: '2025',
  sourceUrl: null,
  sourceYear: year,
  evidenceKind: 'document',
  registryRole: null,
  registryEntryNumber: '20090528111339',
  registryEntryDate: '2009-05-28',
  registryLookupDate: '2026-09-11',
  declaredOffices: [{ institution, position: 'Главен архитект', year }],
});

function render(links: ConflictLink[]) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <CompanyDeclarants links={links} />
    </MemoryRouter>,
  );
  return container;
}

it('groups a shared registry identity, preserving offices, roles, years and the profile link', () => {
  const links = [link('source-a', 'Община А', '2023'), link('source-b', 'Община Б', '2024')].map(
    (l) => ({ ...l, registryPersonId: 'a'.repeat(64) }),
  );
  links[1]!.declaredOffices!.push({
    institution: 'Община Б',
    position: 'Главен експерт',
    year: '2025',
  });
  const original = JSON.stringify(links);
  const container = render(links);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('[data-label="Длъжностно лице"]')?.textContent).toBe(
    'Иван Петров Тестов',
  );
  const offices = container.querySelector('[data-label="Институция и длъжност"]')!;
  for (const value of [
    'Община А',
    'Община Б',
    'Главен архитект',
    'Главен експерт',
    '2023',
    '2024',
    '2025',
  ]) {
    expect(offices.textContent).toContain(value);
  }
  expect(container.querySelector('[data-label="Длъжностно лице"] a')?.getAttribute('href')).toBe(
    '/persons/source-a',
  );
  expect(container.querySelectorAll('.chip')).toHaveLength(1);
  expect(JSON.stringify(links)).toBe(original);
});

it('keeps same-name source profiles separate without a proven registry identity', () => {
  const links = [link('source-a', 'Община А', '2023'), link('source-b', 'Община Б', '2024')];
  expect(render(links).querySelectorAll('tbody tr')).toHaveLength(2);
});

it('keeps contradictory registry identities separate', () => {
  const links = [
    { ...link('source-a', 'Община А', '2023'), registryPersonId: 'a'.repeat(64) },
    { ...link('source-b', 'Община Б', '2024'), registryPersonId: 'b'.repeat(64) },
  ];
  expect(render(links).querySelectorAll('tbody tr')).toHaveLength(2);
});

it('does not transfer a registry identity to another same-name source profile', () => {
  expect(
    render([
      { ...link('source-a', 'Община А', '2023'), registryPersonId: 'a'.repeat(64) },
      link('source-b', 'Община Б', '2024'),
    ]).querySelectorAll('tbody tr'),
  ).toHaveLength(2);
});

it('preserves both kinds of declared participation in the combined row', () => {
  const container = render([
    { ...link('source-a', 'Община А', '2023'), registryPersonId: 'a'.repeat(64) },
    { ...link('source-b', 'Община Б', '2024'), registryPersonId: 'a'.repeat(64), relation: 'owns' },
  ]);
  expect(container.querySelector('[data-label="Декларирано участие"] .chip')?.textContent).toBe(
    'собствен и свързан дял',
  );
});

it('omits the section without declarants', () => {
  expect(render([]).innerHTML).toBe('');
});
