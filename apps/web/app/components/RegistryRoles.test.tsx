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
    expect(cells(c.querySelector('table')!, 'Дял')).toEqual(['500 EUR', '—']);
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
      addedOn: '2019-03-12',
      removedOn: null,
      entryNumber: 'e1',
    };
    const c = render(<PersonRolesTables roles={[r]} />);
    expect(c.querySelector('tbody tr')?.id).toBe(roleRowId(r));
    expect(c.querySelector('a[href="/companies/111111111"]')!.textContent).toBe('АЛФА ООД');
    const partida = [...c.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('ЕИК 111111111'),
    )!;
    expect(partida.getAttribute('href')).toContain('111111111');
    expect(partida.getAttribute('target')).toBe('_blank');
  });
});

describe('RegistrySource', () => {
  it('names the register and the day it was read, and says the page is not a certificate', () => {
    const c = render(<RegistrySource asOf="2026-09-10" />);
    expect(c.textContent).toContain('Агенцията по вписванията, към 10.09.2026');
    expect(c.textContent).toContain('не е удостоверение');
  });
});
