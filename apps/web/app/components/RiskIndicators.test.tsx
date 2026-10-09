// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractDetail, ContractValueTimeline } from '@sigma/api-contract';
import { RiskIndicators } from './RiskIndicators';

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

const value: ContractValueTimeline = {
  estimatedEur: 10_000,
  procedureEstimatedEur: 10_000,
  signingEur: 9_000,
  currentEur: 9_000,
  deltaPct: null,
  suspect: false,
  flag: 'ok',
  currentValueDoubled: false,
};

// Only the fields the risk signals read; the rest of a contract page does not matter here.
const contract = (over: Partial<ContractDetail>): ContractDetail =>
  ({
    bidsReceived: 3,
    bidsRejected: 0,
    euFunded: false,
    dateSuspect: false,
    value,
    ...over,
  }) as ContractDetail;

async function render(c: ContractDetail) {
  const Stub = createRoutesStub([{ path: '/', Component: () => <RiskIndicators contract={c} /> }]);
  await act(async () => {
    root.render(<Stub initialEntries={['/']} />);
  });
  return container.textContent ?? '';
}

describe('RiskIndicators — the value anomaly', () => {
  it("names the contract's own verdict, not one phrase for every flagged value", async () => {
    const text = await render(
      contract({ value: { ...value, suspect: true, flag: 'review' }, dateSuspect: true }),
    );
    expect(text).toContain(
      'Стойностна или времева аномалия: стойността е далеч над прогнозата; договорът е подписан след датата си на публикуване.',
    );
    expect(text).not.toContain('непотвърдена');
  });

  it('gives only the date half when the value is clean', async () => {
    const text = await render(contract({ dateSuspect: true }));
    expect(text).toContain(
      'Стойностна или времева аномалия: договорът е подписан след датата си на публикуване.',
    );
  });

  it('names the competition and mark-up signals, and renders nothing without a signal', async () => {
    let text = await render(
      contract({ bidsReceived: 1, euFunded: true, value: { ...value, deltaPct: 0.5 } }),
    );
    expect(text).toContain('Липса на конкуренция (със средства от ЕС)');
    expect(text).toContain('Ръст на стойността чрез анекси');

    text = await render(contract({ bidsReceived: 1 }));
    expect(text).toContain('Липса на конкуренция:');

    expect(await render(contract({}))).toBe('');
  });
});
