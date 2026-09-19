// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractListItem } from '@sigma/api-contract';
import { UNVERIFIED_HINT } from '../lib/contractValue';
import { ContractMiniTable } from './ContractMiniTable';

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

const contract = (over: Partial<ContractListItem> = {}): ContractListItem => ({
  id: 'contract-1',
  subject: 'Тестова доставка',
  unp: 'TEST-001',
  sectorCode: null,
  euFunded: false,
  isConsortium: false,
  authoritySlug: 'test-authority',
  authorityName: 'Община Тестово',
  bidderSlug: '111111111',
  bidderName: 'ТЕСТ ГРУП ЕООД',
  bidderDisplayName: '„Тест Груп“ ЕООД',
  bidderKind: 'company',
  procedureLabel: 'Открита процедура',
  signedAt: '2025-04-03',
  bidsReceived: 3,
  valueEur: 1234.56,
  valueUnverified: false,
  ...over,
});

function render(items: ContractListItem[], counterparty: 'authority' | 'bidder') {
  const Stub = createRoutesStub([
    {
      path: '/',
      Component: () => <ContractMiniTable items={items} counterparty={counterparty} />,
    },
  ]);
  act(() => root.render(<Stub />));
  return container;
}

const cell = (row: Element, label: string) => row.querySelector(`td[data-label="${label}"]`)!;

describe('ContractMiniTable', () => {
  it('shows authorities, offer counts and verified values on a company page', () => {
    const c = render([contract()], 'authority');
    expect(c.querySelector('caption')?.textContent).toBe('Договори на компанията');
    const row = c.querySelector('tbody tr')!;
    expect(cell(row, 'Дата').textContent).toBe('03.04.2025');
    expect(cell(row, 'Предмет').querySelector('a')?.getAttribute('href')).toBe(
      '/contracts/contract-1',
    );
    expect(cell(row, 'Институция').querySelector('a')?.getAttribute('href')).toBe(
      '/authorities/test-authority',
    );
    expect(cell(row, 'Институция').textContent).toBe('Община Тестово');
    expect(cell(row, 'Оферти').textContent).toBe('3');
    expect(cell(row, 'Стойност (€)').querySelector('.suspect')).toBeNull();
    expect(cell(row, 'Стойност (€)').querySelector('.money-unverified')).toBeNull();
  });

  it('shows bidders and distinguishes missing from unverified values on an authority page', () => {
    const c = render(
      [
        contract({ id: 'missing', bidsReceived: null, valueEur: null }),
        contract({ id: 'unverified', valueEur: 92, valueUnverified: true }),
      ],
      'bidder',
    );
    expect(c.querySelector('caption')?.textContent).toBe('Договори на институцията');
    const rows = [...c.querySelectorAll('tbody tr')];
    const bidder = cell(rows[0]!, 'Изпълнител');
    expect(bidder.querySelector('a')?.getAttribute('href')).toBe('/companies/111111111');
    expect(bidder.textContent).toBe('„Тест Груп“ ЕООД');
    expect(cell(rows[0]!, 'Оферти').textContent).toBe('—');
    expect(cell(rows[0]!, 'Стойност (€)').querySelector('.suspect')?.textContent).toBe(
      'проверяват',
    );
    const unverified = cell(rows[1]!, 'Стойност (€)').querySelector('.money-unverified')!;
    expect(unverified.getAttribute('title')).toBe(UNVERIFIED_HINT);
    expect(unverified.querySelector('.money-unverified-mark')?.textContent).toBe('⚠');
    expect(unverified.querySelector('.sr-only')?.textContent).toContain(UNVERIFIED_HINT);
  });
});
