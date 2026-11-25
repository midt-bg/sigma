import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// On a phone a table becomes cards, each cell a label beside its value. A number cell keeps its value on one
// line (`white-space: nowrap`), and the label — the cell's ::before — inherited that: a long column name such
// as „Стойност в периода на длъжността“ ran on one line over the value instead of wrapping inside its share.
it('lets a card label wrap even inside a number cell', () => {
  const css = readFileSync(resolve(__dirname, 'tables.css'), 'utf8');
  const cards = css.slice(css.indexOf('.tbl-cards td::before {'));
  const rule = cards.slice(0, cards.indexOf('}'));
  expect(rule).toMatch(/white-space:\s*normal/);
});
