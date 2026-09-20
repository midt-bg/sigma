// @vitest-environment jsdom
// The Trade Register's roles as tables: standing roles in the table, ended ones visible under it with the day
// each ended, a person or a winner linked to their page, and the register named as the source.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyRole, PersonRole } from '@sigma/api-contract';
import { CompanyRolesTables, PersonRolesTables, RegistrySource } from './RegistryRoles';
import { roleRowId } from '../lib/profile-navigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(node: React.ReactNode) {
  const Stub = createRoutesStub([
    { path: '/', Component: () => node },
    { path: '/persons/:id', Component: () => null },
    { path: '/companies/:eik', Component: () => null },
  ]);
  act(() => {
    root.render(<Stub initialEntries={['/']} />);
  });
  return container;
}

const role = (over: Partial<CompanyRole> = {}): CompanyRole => ({
  holder: { kind: 'person', name: 'АННА ПЕТРОВА', href: '/persons/ab', eik: null, country: null },
  role: 'manager',
  share: null,
  sharePct: null,
  addedOn: '2019-03-12',
  removedOn: null,
  entryNumber: '20190312101010',
  ...over,
});

const cells = (table: Element, label: string) =>
  [...table.querySelectorAll('tbody td')]
    .filter((td) => td.getAttribute('data-label') === label)
    .map((td) => td.textContent);

describe('CompanyRolesTables', () => {
  it('shows the standing roles, and keeps the ended ones visible under them with the day each ended', () => {
    const c = render(
      <CompanyRolesTables
        roles={[
          role(),
          role({
            holder: { kind: 'person', name: 'БОРИС ИВАНОВ', href: null, eik: null, country: null },
            addedOn: '2015-01-01',
            removedOn: '2019-03-12',
          }),
        ]}
      />,
    );
    const [standing, ended] = [...c.querySelectorAll('table')];
    expect(cells(standing!, 'Роля')).toEqual(['управител']);
    expect(cells(standing!, 'От')).toEqual(['12.03.2019']);
    expect(cells(standing!, 'До')).toEqual([]);
    expect(c.querySelector('.registry-ended h3')!.textContent).toBe('Прекратени роли (1)');
    expect(cells(ended!, 'До')).toEqual(['12.03.2019']);
    const headers = [...ended!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers.indexOf('От')).toBe(headers.indexOf('До') - 1);
    expect(c.querySelector('a[href="/persons/ab"]')!.textContent).toBe('Анна Петрова');
    expect(cells(ended!, 'Лице')).toEqual(['Борис Иванов']);
    expect(role().holder.name).toBe('АННА ПЕТРОВА');
    expect(cells(standing!, 'Вписване №')).toEqual(['20190312101010']);
  });

  it('marks a holder who filed declarations here as an official', () => {
    const c = render(
      <CompanyRolesTables
        roles={[role({ holder: { ...role().holder, official: true } }), role({ role: 'partner' })]}
      />,
    );
    const holders = cells(c.querySelector('table')!, 'Лице');
    expect(holders[0]).toContain('длъжностно лице');
    expect(holders[1]).not.toContain('длъжностно лице');
  });

  it('says who a company is where it has no page here, and never a person’s country', () => {
    const c = render(
      <CompanyRolesTables
        roles={[
          role({
            holder: {
              kind: 'entity',
              name: 'ЧУЖДА ФИРМА ГМБХ',
              href: null,
              eik: null,
              country: 'ГЕРМАНИЯ',
            },
            role: 'partner',
            share: '500 EUR',
            sharePct: 0.25,
          }),
          role({
            holder: {
              kind: 'entity',
              name: 'ХОЛДИНГ АД',
              href: null,
              eik: '444444444',
              country: 'БЪЛГАРИЯ',
            },
            role: 'partner',
          }),
        ]}
      />,
    );
    const names = cells(c.querySelector('table')!, 'Лице');
    expect(names).toEqual(['ЧУЖДА ФИРМА ГМБХ · ГЕРМАНИЯ', 'ХОЛДИНГ АД · ЕИК 444444444']);
    expect(cells(c.querySelector('table')!, 'Дял')).toEqual(['25%', '—']);
  });

  it('says so when no role is standing', () => {
    const c = render(<CompanyRolesTables roles={[role({ removedOn: '2020-01-01' })]} />);
    expect(c.textContent).toContain('Няма вписани роли, които да са в сила.');
  });
});

describe('PersonRolesTables', () => {
  it('links each company to its profile and its partida in the register', () => {
    const r: PersonRole = {
      company: { name: 'АЛФА ООД', eik: '111111111', href: '/companies/111111111' },
      role: 'partner',
      share: '500 BGN',
      sharePct: 0.5,
      addedOn: '2019-03-12',
      removedOn: null,
      entryNumber: 'e1',
      fetchedAt: '2026-09-09T03:00:00Z',
    };
    const c = render(<PersonRolesTables roles={[r]} />);
    expect(c.querySelector('tbody tr')?.id).toBe(roleRowId(r));
    expect(c.querySelector('a[href="/companies/111111111"]')!.textContent).toBe('АЛФА ООД');
    const partida = [...c.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('ЕИК 111111111'),
    )!;
    expect(partida.getAttribute('href')).toContain('111111111');
    expect(partida.getAttribute('target')).toBe('_blank');
    expect(c.textContent).toContain('Извлечено на 09.09.2026');
    expect(cells(c.querySelector('table')!, 'Дял')).toEqual(['50%']);
  });

  // A seat at a public enterprise sits in the same table as a stake in a private company; the reader must be
  // able to tell them apart there (ADR-0047), so the enterprise is named by its ownership.
  it('names a public enterprise as such next to the company', () => {
    const r: PersonRole = {
      company: {
        name: 'ФОНД ТЕСТ ЕАД',
        eik: '977777777',
        href: '/companies/977777777',
        ownershipKind: 'state',
      },
      role: 'board_of_directors',
      share: null,
      sharePct: null,
      addedOn: '2022-02-02',
      removedOn: '2022-08-30',
      entryNumber: 'f1',
      fetchedAt: '2026-09-10T03:00:00Z',
    };
    const c = render(<PersonRolesTables roles={[r]} />);
    const row = c.querySelector('tbody tr')!;
    expect(row.querySelector('a[href="/companies/977777777"]')!.textContent).toBe('ФОНД ТЕСТ ЕАД');
    expect(row.textContent).toContain('държавно');
  });
});

describe('RegistrySource', () => {
  it('does not invent a shared retrieval date for a person’s multiple partidas', () => {
    const c = render(<RegistrySource />);
    expect(c.textContent).not.toContain('Данните са извлечени на');
    expect(c.querySelector('a[href="/conflicts/methodology#registry-publication"]')).not.toBeNull();
  });

  it('names the register and the day it was read, and says the page is not a certificate', () => {
    const c = render(<RegistrySource asOf="2026-09-10" eik="111111111" />);
    expect(c.textContent).toContain('Официален източник: Агенция по вписванията');
    expect(c.textContent).toContain('Данните са извлечени на 10.09.2026');
    expect(c.textContent).toContain('структурира и съпоставя');
    expect(c.textContent).toContain('не е удостоверителен документ');
    expect(c.querySelector('a[href*="111111111"]')).not.toBeNull();
    expect(c.querySelector('a[href="/conflicts/methodology#contest"]')).not.toBeNull();
  });
});

describe('RegistryRoles — uncertain and unlinked entries', () => {
  const ended = () => container.querySelector('.registry-ended')!;

  it('files a role whose evidence turns uncertain under history, without inventing an end date', () => {
    render(<CompanyRolesTables roles={[role({ uncertainAfter: '2024-01-15' })]} />);
    expect(container.textContent).toContain('Няма вписани роли, които да са в сила.');
    expect(ended().querySelector('h3')!.textContent).toBe('История на ролите (1)');
    expect(cells(ended().querySelector('table')!, 'До')).toEqual(['Неустановено след 15.01.2024']);
  });

  it('gives the registered end date once there is one, and keeps the history heading', () => {
    render(
      <CompanyRolesTables
        roles={[
          role({ uncertainAfter: '2024-01-15', removedOn: '2024-06-01' }),
          role({ entryNumber: 'e-old', removedOn: '2020-02-02' }),
        ]}
      />,
    );
    expect(ended().querySelector('h3')!.textContent).toBe('История на ролите (2)');
    expect(cells(ended().querySelector('table')!, 'До')).toEqual(['01.06.2024', '02.02.2020']);
  });

  it('names a company with no page here as plain text, and says when the reading date is unknown', () => {
    const r: PersonRole = {
      company: { name: 'ДЕЛТА ЕООД', eik: '333333333', href: null },
      role: 'manager',
      share: null,
      sharePct: null,
      addedOn: '2020-02-02',
      removedOn: null,
      entryNumber: 'e2',
      fetchedAt: '',
    };
    render(<PersonRolesTables roles={[r]} />);
    const table = container.querySelector('table')!;
    expect(cells(table, 'Дружество')).toEqual(['ДЕЛТА ЕООД']);
    expect(table.querySelector('td[data-label="Дружество"] a')).toBeNull();
    expect(cells(table, 'Партида')[0]).toContain('Извлечено на неизвестна дата');
  });
});
