// @vitest-environment jsdom
// On phones the table reflows into label/value cards; the label is each column's header, stamped on its cells
// as `data-label` at render time. Only a plain-text header can be that label — a header built from markup has
// no text to stamp, so its cells carry none rather than „[object Object]".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DataTable, type Column } from './DataTable';

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

interface Row {
  name: string;
  value: string;
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Име', isTitle: true, cell: (r) => r.name },
  {
    key: 'value',
    header: <abbr title="Стойност в евро">Ст.</abbr>,
    align: 'money',
    secondary: true,
    cell: (r) => r.value,
  },
];

it('labels a cell with its text header for the phone cards, and leaves a markup header unlabelled', () => {
  act(() => {
    root.render(
      <DataTable columns={columns} rows={[{ name: 'Алфа', value: '12' }]} getKey={(r) => r.name} />,
    );
  });
  const [name, value] = [...container.querySelectorAll('tbody td')];
  expect(name!.getAttribute('data-label')).toBe('Име');
  expect(name!.className).toBe('cell-title');
  expect(value!.hasAttribute('data-label')).toBe(false);
  expect(value!.textContent).toBe('12');
  expect(value!.className).toBe('money col-secondary');
  // The markup header itself is rendered as given, in the numeric header style of a money column.
  const header = container.querySelectorAll('thead th')[1]!;
  expect(header.querySelector('abbr')!.getAttribute('title')).toBe('Стойност в евро');
  expect(header.className).toBe('num col-secondary');
});
