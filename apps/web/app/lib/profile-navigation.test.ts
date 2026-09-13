// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { declarationRowId, revealProfileTarget } from './profile-navigation';
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
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
