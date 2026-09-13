// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { declarationRowId, roleRowId, revealProfileTarget } from './profile-navigation';
import type { PersonRole } from '@sigma/api-contract';
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});
it('distinguishes company, role and period when targeting a registry row', () => {
  const role: PersonRole = {
    company: { eik: '123456789', name: 'Фирма', href: null },
    role: 'manager',
    addedOn: '2020-01-01',
    removedOn: null,
    entryNumber: '1',
    share: null,
  };
  const ids = [
    role,
    { ...role, removedOn: '2021-01-01' },
    { ...role, addedOn: '2022-01-01' },
    { ...role, company: { ...role.company, eik: '987654321' } },
    { ...role, role: 'partner' as const },
  ].map(roleRowId);
  expect(new Set(ids).size).toBe(ids.length);
});
it('focuses the exact declaration and restarts its temporary indication on repeated navigation', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<table><tbody><tr><td>Document</td></tr></tbody></table>';
  const row = document.querySelector('tr')!;
  row.id = declarationRowId('doc:/2023#2');
  row.scrollIntoView = vi.fn();
  revealProfileTarget(row.id);
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  expect(document.activeElement).toBe(row);
  expect(row.classList.contains('profile-target')).toBe(true);
  vi.advanceTimersByTime(1800);
  revealProfileTarget(row.id);
  vi.advanceTimersByTime(500);
  expect(row.classList.contains('profile-target')).toBe(true);
  vi.advanceTimersByTime(1700);
  expect(row.classList.contains('profile-target')).toBe(false);
});
