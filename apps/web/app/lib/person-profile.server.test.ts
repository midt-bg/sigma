import { expect, it, vi } from 'vitest';
import type { PersonDeclaration } from '@sigma/api-contract';
import { emptyActivity } from './person-profile.test-support';

const q = vi.hoisted(() => ({
  getRegistryPerson: vi.fn(),
  getRegistryOfficials: vi.fn(),
  getOfficialConflicts: vi.fn(),
  getPersonDeclarations: vi.fn(),
  getPersonActivity: vi.fn(),
  getPersonTimeline: vi.fn(),
}));
vi.mock('@sigma/db', () => q);
import { loadPersonProfile } from './person-profile.server';

it('limits company mentions to eligible profiles while retaining every source and institutional fact', async () => {
  const eligible = '111111111',
    outside = '222222222';
  const declarations: PersonDeclaration[] = [
    {
      id: 'd',
      year: '2020',
      template: 'assets',
      type: 'Annual',
      declaredOn: '2021-01-01',
      submittedOn: null,
      institution: 'Община А',
      position: 'Кмет',
      url: 'https://example.test/d',
      companyEiks: [eligible, outside],
      interests: [
        { eik: eligible, company: 'Изпълнител', kind: 'shares', timing: 'prior', scope: 'self' },
        { eik: outside, company: 'Без профил', kind: 'shares', timing: 'annual', scope: 'self' },
        { eik: null, company: 'Изпълнител', kind: 'shares', timing: 'annual', scope: 'unknown' },
      ],
      discrepancies: [eligible, outside].map((eik) => ({
        eik,
        company: eik,
        year: '2020',
        scope: 'self',
        listed: true,
        otherDeclarationIds: ['other'],
      })),
    },
  ];
  declarations.push({
    ...declarations[0]!,
    id: 'other',
    companyEiks: [outside],
    interests: declarations[0]!.interests!.slice(1),
    discrepancies: [],
  });
  q.getOfficialConflicts.mockResolvedValue({
    official: 'Тестово лице',
    links: [{ eik: eligible }, { eik: outside }],
  });
  q.getPersonDeclarations.mockResolvedValue(declarations);
  // A year filter can return zero contracts without hiding an otherwise eligible company.
  q.getPersonActivity.mockResolvedValue({
    ...emptyActivity,
    companies: [{ eik: eligible, name: 'Изпълнител' }],
  });
  q.getPersonTimeline.mockResolvedValue({
    contracts: [],
    reads: [],
    observations: [{ eik: eligible }, { eik: outside }],
  });

  const p = (await loadPersonProfile({} as D1Database, {
    officialId: 'p',
    search: new URLSearchParams('year=1900'),
  }))!;
  expect(p.links.map((l) => l.eik)).toEqual([eligible]);
  expect(p.timeline.observations.map((o) => o.eik)).toEqual([eligible]);
  expect(p.declarations).toHaveLength(2);
  const source = p.declarations.find((d) => d.id === 'd')!;
  expect(source).toMatchObject({
    institution: 'Община А',
    position: 'Кмет',
    companyEiks: [eligible],
    url: 'https://example.test/d',
  });
  expect(source.interests).toEqual([declarations[0]!.interests![0]]);
  expect(source.discrepancies).toEqual([declarations[0]!.discrepancies![0]]);
  expect(p.declarations.find((d) => d.id === 'other')).toMatchObject({
    companyEiks: [],
    interests: [],
  });
  expect(declarations[0]!.interests).toHaveLength(3); // source objects remain intact
});
