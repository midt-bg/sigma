import type { ReactNode } from 'react';

// A column definition. `cell` renders the value; `isTitle`/`isRank` tag the cells the mobile card
// reflow promotes to a heading / corner badge. `align` → the numeric/centre classes.
export interface Column<Row> {
  key: string;
  header: ReactNode;
  align?: 'num' | 'center' | 'money'; // "money" → right-aligned mono cell, numeric header
  secondary?: boolean; // hidden on tablet widths (.col-secondary)
  isTitle?: boolean; // becomes the card heading on phones
  isRank?: boolean; // becomes the corner badge on phones
  cell: (row: Row, index: number) => ReactNode;
}

// The mock reflows wide tables into stacked label/value cards on phones. The original did this with
// JS that annotated each <td> from its header; we emit `data-label` (and cell-title/cell-rank) at SSR
// instead — same result, no client script. `variant`: "cards" for metric tables, "prose" for text.
export function DataTable<Row>({
  columns,
  rows,
  variant = 'cards',
  caption,
  getKey,
  rowLink = false,
}: {
  columns: Column<Row>[];
  rows: Row[];
  variant?: 'cards' | 'prose';
  caption?: string;
  getKey: (row: Row, index: number) => string | number;
  // Opt in to the whole-row „stretched link" pattern: each row is marked `.row-link` and the anchor in
  // its `isTitle` cell overlays the entire row (CSS `::after`), so a click anywhere on the row (or card,
  // on phones) follows that link. Pure CSS — the anchor stays the accessible, keyboard-focusable target,
  // so the title column MUST render a single <Link>/<a>. No effect on tables that don't opt in.
  rowLink?: boolean;
}) {
  const labelOf = (c: Column<Row>) => (typeof c.header === 'string' ? c.header : undefined);
  return (
    <div className={`table-wrap tbl-${variant}`}>
      <table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={
                  [c.align === 'money' ? 'num' : c.align, c.secondary ? 'col-secondary' : '']
                    .filter(Boolean)
                    .join(' ') || undefined
                }
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={getKey(row, i)} className={rowLink ? 'row-link' : undefined}>
              {columns.map((c) => {
                const cls = [
                  c.align,
                  c.secondary ? 'col-secondary' : '',
                  c.isTitle ? 'cell-title' : '',
                  c.isRank ? 'cell-rank' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <td key={c.key} className={cls || undefined} data-label={labelOf(c)}>
                    {c.cell(row, i)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
