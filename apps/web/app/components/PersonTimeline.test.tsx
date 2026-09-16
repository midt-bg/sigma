// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { ConflictLink } from '@sigma/api-contract';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { emptyActivity } from '../lib/person-profile.test-support';
import { timelineCompanies } from '../lib/person-timeline';
import { PersonProfile } from './PersonProfile';
import { PersonTimeline } from './PersonTimeline';
import { PersonRolesTables } from './RegistryRoles';
import { roleRowId } from '../lib/profile-navigation';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows one company for multiple source identities, sequential sections and historical facts without invented role bars', () => {
  const link: ConflictLink = {
    linkKey: 'a|123456789',
    officialSlug: 'a',
    official: 'Ивана Петрова Тестова',
    institution: 'Община А',
    position: null,
    company: 'Тестова фирма',
    eik: '123456789',
    relation: 'owns',
    contemporaneous: false,
    ownInstitution: false,
    firstDeclaredYear: null,
    lastDeclaredYear: null,
    contractCount: 2,
    contractValueEur: 100,
    contemporaneousContractCount: 0,
    contemporaneousValueEur: null,
    firstContractYear: '2020',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/a.xml',
    sourceYear: '2023',
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20100101',
    registryEntryDate: '2010-01-01',
    registryLookupDate: '2026-09-01',
  };
  const p: LoadedPersonProfile = {
    person: null,
    name: link.official,
    links: [link, { ...link, linkKey: 'b|123456789', officialSlug: 'b' }],
    declarations: [
      {
        id: 'd',
        year: '2023',
        template: 'interests',
        type: 'Assume',
        declaredOn: '2024-01-01',
        submittedOn: null,
        institution: 'Община А',
        position: 'Длъжност',
        url: link.sourceUrl!,
        companyEiks: [link.eik],
      },
    ],
    timeline: {
      reads: [],
      buyers: [
        {
          eik: link.eik,
          year: '2024',
          id: 'auth:1',
          name: 'Възложител А',
          contracts: 2,
          eligible: 0,
          valueEur: 100,
        },
      ],
      institutionProfiles: [],
      observations: [
        {
          eik: link.eik,
          declarationId: 'd',
          kind: 'management',
          timing: 'current',
          reportedYear: '2021',
          scope: 'self',
        },
        {
          eik: link.eik,
          declarationId: 'd',
          kind: 'participation',
          timing: 'prior',
          reportedYear: '2023',
          scope: 'self',
        },
      ],
      contracts: [
        {
          eik: link.eik,
          company: link.company,
          year: '2024',
          contracts: 2,
          role: 0,
          declared: 0,
          eligible: 0,
          valueEur: 100,
        },
      ],
    },
    activity: emptyActivity,
    totals: { companies: 0, contracts: 0, valueEur: null, declaredCount: 0, declaredEur: null },
    tieLayout: null,
    aliases: [],
  };
  const companies = timelineCompanies(p);
  expect(companies).toHaveLength(1);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const Stub = createRoutesStub([{ path: '/', Component: () => <PersonProfile profile={p} /> }]);
  try {
    act(() => root.render(<Stub />));
    expect(el.querySelectorAll('.person-time-company')).toHaveLength(1);
    expect(el.querySelectorAll('details')).toHaveLength(0);
    expect(el.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    expect(el.querySelectorAll('.time-role')).toHaveLength(0);
    expect(el.querySelectorAll('.time-management')).toHaveLength(1);
    expect(
      el.querySelectorAll('.person-time-company .time-observation:not(.time-management)'),
    ).toHaveLength(0);
    expect(el.querySelectorAll('.time-institution .time-observation')).toHaveLength(1);
    expect(el.querySelectorAll('.time-contract.eligible')).toHaveLength(0);
    expect(el.querySelector('.time-contract.context')?.textContent).toBe('2');
    expect(el.querySelector('.time-contract-bin .help-trigger')).toBeNull();
    expect(el.querySelector('.time-contract-bin .time-institution-trigger')).toBeNull();
    const ids = [...el.querySelectorAll('.section > h2[id]')].map((s) => s.id);
    expect(ids.indexOf('declared-overview')).toBeLessThan(ids.indexOf('timeline'));
    expect(ids.indexOf('declarations')).toBeLessThan(ids.indexOf('contracts'));
    expect(ids.at(-1)).toBe('contracts');
    const notes = el.querySelector('.person-time-notes')!;
    const companyHeading = notes.closest('.time-company-heading')!;
    expect(companyHeading.closest('.person-time-company')).not.toBeNull();
    expect(companyHeading.querySelector('strong')?.textContent).toBe(link.company);
    expect(notes.closest('.person-time-row')).toBeNull();
    expect(el.querySelectorAll('.time-company-heading')).toHaveLength(1);
    expect(notes.textContent).toContain('Лична роля в ТР не е установена');
    expect(notes.textContent).toContain('Предходно участие');
    expect(notes.querySelector('a[href="#declaration-d"]')).not.toBeNull();
    expect(
      [...el.querySelectorAll('.person-time-row')].map((r) => r.textContent).join(' '),
    ).not.toMatch(/Не е установена|Предходно участие/);
    expect(el.querySelector('#declaration-d a')?.getAttribute('href')).toBe(link.sourceUrl);
    p.declarations[0]!.interests = [
      { company: link.company, eik: link.eik, kind: 'shares', timing: 'annual', scope: 'self' },
    ];
    p.declarations[0]!.discrepancies = [
      {
        company: link.company,
        eik: link.eik,
        year: '2023',
        scope: 'self',
        listed: true,
        otherDeclarationIds: ['other'],
      },
    ];
    p.declarations.push({
      ...p.declarations[0]!,
      id: 'other',
      companyEiks: [],
      interests: [],
      discrepancies: [
        {
          company: link.company,
          eik: link.eik,
          year: '2023',
          scope: 'self',
          listed: false,
          otherDeclarationIds: ['d'],
        },
      ],
    });
    p.timeline.observations.push(
      {
        eik: link.eik,
        declarationId: 'd',
        kind: 'shares',
        timing: 'annual',
        reportedYear: '2023',
        scope: 'self',
        disputed: 1,
      },
      {
        eik: link.eik,
        declarationId: 'other',
        kind: 'shares',
        timing: 'not_listed',
        reportedYear: '2023',
        scope: 'self',
        disputed: 1,
      },
    );
    act(() => root.render(<Stub key="disputed" />));
    expect(el.querySelectorAll('.time-disputed')).toHaveLength(1);
    const discrepancyNotes = el.querySelector('.person-time-notes')!;
    expect(discrepancyNotes.textContent).toContain('Разминаване в декларациите');
    for (const id of ['d', 'other']) {
      expect(discrepancyNotes.querySelector(`a[href="#declaration-${id}"]`)).not.toBeNull();
    }
    expect(el.querySelector('#declaration-other')?.textContent).toContain('не е посочен тук');
    expect(
      el.querySelector('#declaration-d .declaration-discrepancy a[href="#declaration-other"]'),
    ).not.toBeNull();
    expect(el.querySelector('#declaration-other .entity-list')).toBeNull(); // omission never creates an interest
    p.timeline.institutionProfiles = [{ institution: 'Община А', authorityId: 'auth:1' }];
    p.timeline.buyers.push(
      { ...p.timeline.buyers[0]!, id: 'auth:other', name: 'Несвързан възложител', valueEur: 9999 },
      { ...p.timeline.buyers[0]!, year: '2020', name: 'Същата институция през друга година' },
      { ...p.timeline.buyers[0]!, eik: '999999999', name: 'Същата институция за друга фирма' },
    );
    act(() => root.render(<Stub key="own-institution" />));
    expect(el.querySelectorAll('.time-institution-trigger')).toHaveLength(1);
    expect(el.querySelector('.time-institution-trigger')?.textContent).toBe('');
    expect(el.querySelector('.time-institution-trigger')?.getAttribute('aria-label')).toContain(
      '2024',
    );
    const buyerLink = el.querySelector('.time-buyers-list a')!;
    expect(buyerLink.getAttribute('href')).toContain(
      'year=2024&authority=auth%3A1#contract-filters',
    );
    expect(el.querySelector('.time-buyers-list')?.textContent).toContain('Възложител А');
    expect(el.querySelector('.time-buyers-list')?.textContent).not.toMatch(
      /Несвързан|друга година|друга фирма/,
    );
    expect(el.querySelector('.time-buyers-list')?.textContent).not.toContain('9999');
    const roles = (['manager', 'partner'] as const).flatMap((role) => [
      {
        company: { name: link.company, eik: link.eik, href: `/companies/${link.eik}` },
        role,
        share: null,
        sharePct: null,
        addedOn: '2013-01-17',
        removedOn: '2013-08-14',
        entryNumber: 'old',
        fetchedAt: '2026-09-09T03:00:00Z',
      },
      {
        company: { name: link.company, eik: link.eik, href: `/companies/${link.eik}` },
        role,
        share: null,
        sharePct: null,
        addedOn: '2022-11-16',
        removedOn: '2024-05-27',
        entryNumber: 'new',
        fetchedAt: '2026-09-09T03:00:00Z',
      },
    ]);
    const Roles = createRoutesStub([
      {
        path: '/',
        Component: () => (
          <>
            <PersonTimeline profile={p} companies={[{ ...companies[0]!, roles }]} />
            <PersonRolesTables roles={roles} />
          </>
        ),
      },
    ]);
    act(() => root.render(<Roles />));
    const roleRows = [...el.querySelectorAll('.person-time-company .person-time-row')].filter((r) =>
      r.querySelector('.time-role'),
    );
    expect(roleRows).toHaveLength(2);
    for (const row of roleRows) {
      const segments = row.querySelectorAll<HTMLElement>('.time-role');
      expect(segments).toHaveLength(2);
      expect(
        parseFloat(segments[0]!.style.left) + parseFloat(segments[0]!.style.width),
      ).toBeLessThan(parseFloat(segments[1]!.style.left));
    }
    for (const role of roles) {
      const id = roleRowId(role);
      const target = document.getElementById(id)!;
      expect(target.tagName).toBe('TR');
      expect(target.closest('.registry-ended')).not.toBeNull();
      target.scrollIntoView = vi.fn();
      const bar = [...el.querySelectorAll<HTMLAnchorElement>('.time-role')].find(
        (a) => a.getAttribute('href') === `#${id}`,
      )!;
      act(() => bar.click());
      expect(document.activeElement).toBe(target);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
      expect(target.classList.contains('profile-target')).toBe(true);
    }
  } finally {
    act(() => root.unmount());
    el.remove();
  }
});
