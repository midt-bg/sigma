// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import type { ConflictLink } from '@sigma/api-contract';
import { CompanyDeclarants } from './CompanyDeclarants';
import { companyDeclarantGroups } from '../lib/company-declarants';
import { groupByPerson } from '../lib/conflicts';

const pazardzhik =
  '0KDQo9Cc0JXQnSDQodCi0JXQpNCQ0J3QntCSINCh0KLQldCk0JDQndCe0JJ80J_QkNCX0JDQoNCU0JbQmNCa';
const belovo = '0KDQo9Cc0JXQnSDQodCi0JXQpNCQ0J3QntCSINCh0KLQldCk0JDQndCe0JJ80JHQldCb0J7QktCe';
const link = (officialSlug: string, institution: string, year: string): ConflictLink => ({
  linkKey: `${officialSlug}|112032875|family`,
  officialSlug,
  official: 'РУМЕН СТЕФАНОВ СТЕФАНОВ',
  institution,
  position: 'Главен архитект',
  company: 'СИГМА-СТРОЙ ООД',
  eik: '112032875',
  relation: 'related',
  contemporaneous: true,
  ownInstitution: false,
  firstDeclaredYear: year,
  lastDeclaredYear: year,
  matchMethod: 'eik',
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

it('shows the reviewed person once, preserving every office, year and source profile', () => {
  const links = [link(pazardzhik, 'Пазарджик', '2023'), link(belovo, 'Белово', '2024')];
  links[1]!.declaredOffices!.push({
    institution: 'Белово',
    position: 'Главен експерт',
    year: '2025',
  });
  const original = JSON.stringify(links);
  const container = render(links);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('[data-label="Длъжностно лице"]')?.textContent).toBe(
    'Румен Стефанов Стефанов',
  );
  const offices = container.querySelector('[data-label="Институция и длъжност"]')!;
  for (const value of [
    'Пазарджик',
    'Белово',
    'Главен архитект',
    'Главен експерт',
    '2023',
    '2024',
    '2025',
  ]) {
    expect(offices.textContent).toContain(value);
  }
  expect([...offices.querySelectorAll('a')].map((a) => a.getAttribute('href')).sort()).toEqual(
    [pazardzhik, belovo].map((s) => `/conflicts/official/${s}`).sort(),
  );
  expect(container.querySelectorAll('.chip')).toHaveLength(1);
  expect(JSON.stringify(links)).toBe(original);
  // The presentation correction does not change profile identity or financial aggregation.
  expect(groupByPerson(links)).toHaveLength(2);
});

it('does not merge a namesake with an unreviewed source profile, even in the same company', () => {
  const links = [link(pazardzhik, 'Пазарджик', '2023'), link('namesake', 'Друга община', '2024')];
  expect(render(links).querySelectorAll('tbody tr')).toHaveLength(2);
});

it('keeps contradictory registry identities separate', () => {
  const links = [
    { ...link(pazardzhik, 'Пазарджик', '2023'), registryPersonId: 'person-a' },
    { ...link(belovo, 'Белово', '2024'), registryPersonId: 'person-b' },
  ];
  expect(companyDeclarantGroups(links)).toHaveLength(2);
});

it('preserves both kinds of declared participation in the combined row', () => {
  const container = render([
    link(pazardzhik, 'Пазарджик', '2023'),
    { ...link(belovo, 'Белово', '2024'), relation: 'owns' },
  ]);
  expect(container.querySelector('[data-label="Декларирано участие"] .chip')?.textContent).toBe(
    'собствен и свързан дял',
  );
});

it('omits the section without declarants', () => {
  expect(render([]).innerHTML).toBe('');
});
