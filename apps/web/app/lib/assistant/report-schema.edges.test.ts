// Report binding at its edges: a value that is not a finite number never plots, an entity that names no
// character stays as written, a missing or empty cell binds as null — never `undefined` — and a data block
// pointing at a result that does not exist is an error the model must fix, not an empty block.
import { describe, expect, it } from 'vitest';
import {
  asNumber,
  bindReport,
  sanitizeProse,
  type EmitReportInput,
  type QueryResult,
} from './report-schema';

const emit = (blocks: EmitReportInput['blocks']): EmitReportInput => ({
  title: 'Справка',
  question: 'въпрос',
  blocks,
});

describe('asNumber — only finite numbers', () => {
  it('drops an infinite or NaN number', () => {
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
  });

  it('drops a decimal string too large for a number', () => {
    expect(asNumber('9'.repeat(400))).toBeNull();
    expect(asNumber(' 12.5 ')).toBe(12.5);
  });
});

describe('sanitizeProse — numeric entities that name no character', () => {
  it('leaves an out-of-range entity as written', () => {
    expect(sanitizeProse('а &#1114112; б &#x110000; в &#65; г')).toBe(
      'а &#1114112; б &#x110000; в A г',
    );
  });
});

describe('bindReport — missing and empty cells', () => {
  const results: QueryResult[] = [
    // A ragged row: shorter than its columns.
    { handle: 'G', columns: ['label', 'value'], rows: [['Община Русе']] },
    { handle: 'N', columns: ['label', 'value'], rows: [[null, 5]] },
  ];

  it('binds a cell past the end of a ragged row as null', () => {
    const out = bindReport(
      emit([
        {
          type: 'totals',
          items: [{ label: 'Общо', ref: { resultId: 'G', row: 0, col: 'value' }, format: 'money' }],
        },
      ]),
      results,
    );
    expect(out).toMatchObject({
      ok: true,
      report: { blocks: [{ type: 'totals', items: [{ label: 'Общо', value: null }] }] },
    });
  });

  it('keeps an empty table cell and an empty bar label as null', () => {
    const out = bindReport(
      emit([
        {
          type: 'table',
          resultId: 'N',
          columns: [
            { key: 'label', header: 'Име', format: 'text' },
            { key: 'value', header: 'Стойност', format: 'number' },
          ],
        },
        { type: 'bar', resultId: 'N', labelCol: 'label', valueCol: 'value' },
      ]),
      results,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.blocks[0]).toMatchObject({ rows: [{ cells: [null, 5] }] });
    expect(out.report.blocks[1]).toMatchObject({ points: [{ label: null, value: 5 }] });
  });
});

describe('bindReport — a data block with no such result', () => {
  it('rejects a table, bar or timeseries over an unknown handle', () => {
    const out = bindReport(
      emit([
        { type: 'table', resultId: 'R9', columns: [{ key: 'a', header: 'А', format: 'text' }] },
        { type: 'bar', resultId: 'R9', labelCol: 'a', valueCol: 'b' },
        { type: 'timeseries', resultId: 'R9', periodCol: 'a', valueCol: 'b' },
      ]),
      [],
    );
    expect(out).toEqual({
      ok: false,
      errors: [
        'block[0] (table): unknown result handle "R9"',
        'block[1] (bar): unknown result handle "R9"',
        'block[2] (timeseries): unknown result handle "R9"',
      ],
    });
  });
});
