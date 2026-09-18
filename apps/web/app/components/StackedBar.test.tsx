// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcedureSlice } from '@sigma/api-contract';
import { StackedBar } from './StackedBar';

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

const slice = (over: Partial<ProcedureSlice> = {}): ProcedureSlice => ({
  key: 'open',
  label: 'Открита процедура',
  color: '#222222',
  competitive: true,
  contracts: 2,
  valueEur: 100,
  sharePct: 0.25,
  ...over,
});

function render(slices: ProcedureSlice[]) {
  act(() => root.render(<StackedBar slices={slices} />));
  return container;
}

describe('StackedBar', () => {
  it('renders nothing when every slice is below the visible threshold', () => {
    expect(render([]).textContent).toBe('');
    expect(render([slice({ sharePct: 0.0004 })]).querySelector('.hbar')).toBeNull();
  });

  it('draws visible slices, clamps their widths and repeats their labels in the legend', () => {
    const c = render([
      slice(),
      slice({
        key: 'direct',
        label: 'Пряко договаряне',
        color: '#aa0000',
        competitive: false,
        sharePct: 1.25,
      }),
      slice({ key: 'rounding', label: 'Под прага', sharePct: 0.0004 }),
    ]);

    const segments = [...c.querySelectorAll<HTMLElement>('.hbar > span')];
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.style.width)).toEqual(['25%', '100%']);
    expect(segments.map((segment) => segment.style.background)).toEqual([
      'rgb(34, 34, 34)',
      'rgb(170, 0, 0)',
    ]);
    expect(segments[0]!.title).toContain('Открита процедура');
    const legend = c.querySelector('.hbar-legend')!;
    expect(legend.querySelectorAll(':scope > span')).toHaveLength(2);
    expect(legend.textContent).toContain('Открита процедура');
    expect(legend.textContent).toContain('Пряко договаряне');
    expect(legend.textContent).not.toContain('Под прага');
  });
});
