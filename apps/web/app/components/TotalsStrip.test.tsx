// @vitest-environment jsdom
// A definition list may only hold dt/dd groups (optionally wrapped in a div): each cell is one group, label
// as the term, number as the definition.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TotalsStrip } from './TotalsStrip';

describe('TotalsStrip', () => {
  it('renders each cell as a dt/dd group', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <TotalsStrip
        label="Накратко"
        totals={[
          { num: '12', label: 'договора' },
          { num: '3,4 млн. €', label: 'стойност' },
        ]}
      />,
    );
    const cells = [...host.querySelectorAll('dl.totals > div.cell')];
    expect(cells.map((c) => [...c.children].map((e) => e.tagName))).toEqual([
      ['DT', 'DD'],
      ['DT', 'DD'],
    ]);
    expect(cells[1]!.querySelector('dt')!.textContent).toBe('стойност');
    expect(cells[1]!.querySelector('dd')!.textContent).toBe('3,4 млн. €');
  });
});
