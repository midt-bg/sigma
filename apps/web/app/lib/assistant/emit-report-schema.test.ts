import { describe, expect, it } from 'vitest';
import { EMIT_REPORT_JSON_SCHEMA, validateEmitShape } from './emit-report-schema';

describe('validateEmitShape', () => {
  it('accepts a well-formed report (refs not yet resolved — that is bindReport)', () => {
    const r = validateEmitShape({
      title: 'Топ възложители',
      question: 'кои са най-големите?',
      blocks: [
        { type: 'text', md: 'Ето резултатите.' },
        {
          type: 'totals',
          items: [
            { label: 'Общо', ref: { resultId: 'R1', row: 0, col: 'total_eur' }, format: 'money' },
          ],
        },
        {
          type: 'table',
          resultId: 'R2',
          columns: [{ key: 'name', header: 'Институция', format: 'text' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing title and a non-array blocks', () => {
    expect(validateEmitShape({ question: '', blocks: [] }).ok).toBe(false);
    expect(validateEmitShape({ title: 'x', question: '', blocks: 'nope' }).ok).toBe(false);
  });

  it('rejects an unknown block type', () => {
    const r = validateEmitShape({ title: 't', question: '', blocks: [{ type: 'pie' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/invalid or missing "type"/);
  });

  it('rejects a totals item missing a valid ref or format', () => {
    const r = validateEmitShape({
      title: 't',
      question: '',
      blocks: [
        {
          type: 'totals',
          items: [{ label: 'x', ref: { resultId: 'R1', row: 0 }, format: 'money' }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    const bad = validateEmitShape({
      title: 't',
      question: '',
      blocks: [
        {
          type: 'totals',
          items: [{ label: 'x', ref: { resultId: 'R1', row: 0, col: 'c' }, format: 'pie' }],
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('rejects a table with no columns and a bar missing valueCol', () => {
    expect(
      validateEmitShape({
        title: 't',
        question: '',
        blocks: [{ type: 'table', resultId: 'R1', columns: [] }],
      }).ok,
    ).toBe(false);
    expect(
      validateEmitShape({
        title: 't',
        question: '',
        blocks: [{ type: 'bar', resultId: 'R1', labelCol: 'a' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects a table column with an invalid link kind, accepts a valid one (review #80)', () => {
    const tbl = (link: unknown) => ({
      title: 't',
      question: '',
      blocks: [
        {
          type: 'table',
          resultId: 'R1',
          columns: [{ key: 'name', header: 'Име', format: 'text', link }],
        },
      ],
    });
    expect(validateEmitShape(tbl({ kind: 'evil', idCol: 'eik' })).ok).toBe(false);
    expect(validateEmitShape(tbl({ kind: 'company', idCol: 'eik' })).ok).toBe(true);
    expect(validateEmitShape(tbl({ kind: 'company' })).ok).toBe(false); // idCol required
  });

  it('validates the optional column align (whitelist left|right), rejecting anything else', () => {
    const tbl = (align: unknown) => ({
      title: 't',
      question: '',
      blocks: [
        {
          type: 'table',
          resultId: 'R1',
          columns: [{ key: 'name', header: 'Име', align, format: 'text' }],
        },
      ],
    });
    expect(validateEmitShape(tbl('right')).ok).toBe(true);
    expect(validateEmitShape(tbl(undefined)).ok).toBe(true);
    expect(validateEmitShape(tbl('center')).ok).toBe(false);
    expect(validateEmitShape(tbl('"><b>')).ok).toBe(false);
  });

  it('caps oversized model arrays (blocks, items, columns)', () => {
    const many = (n: number, make: (i: number) => unknown) =>
      Array.from({ length: n }, (_, i) => make(i));
    // too many blocks
    expect(
      validateEmitShape({
        title: 't',
        question: '',
        blocks: many(101, () => ({ type: 'text', md: 'x' })),
      }).ok,
    ).toBe(false);
    // too many totals items
    expect(
      validateEmitShape({
        title: 't',
        question: '',
        blocks: [
          {
            type: 'totals',
            items: many(51, () => ({
              label: 'x',
              ref: { resultId: 'R1', row: 0, col: 'c' },
              format: 'money',
            })),
          },
        ],
      }).ok,
    ).toBe(false);
    // too many columns
    expect(
      validateEmitShape({
        title: 't',
        question: '',
        blocks: [
          {
            type: 'table',
            resultId: 'R1',
            columns: many(51, (i) => ({ key: `k${i}`, header: 'h', format: 'text' })),
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('stops at the cap error instead of scanning the oversized array (review follow-up)', () => {
    // Every over-cap block is ALSO individually invalid ({} has no type). Pre-fix, the per-block loop
    // still ran and pushed 101 per-block errors; now the cap short-circuits, so exactly the one cap error
    // is reported and the oversized structure is never walked.
    const out = validateEmitShape({
      title: 't',
      question: '',
      blocks: Array.from({ length: 101 }, () => ({})),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors).toEqual(['blocks: at most 100']);

    // Same for an over-cap items array: the per-item scan is skipped, so only the cap error surfaces
    // (each item here is also invalid — missing label/ref/format — but none of them get walked).
    const items = validateEmitShape({
      title: 't',
      question: '',
      blocks: [{ type: 'totals', items: Array.from({ length: 51 }, () => ({})) }],
    });
    expect(items.ok).toBe(false);
    if (!items.ok) expect(items.errors.some((e) => /items\[\d+\]/.test(e))).toBe(false);
  });

  it('rejects a non-integer ref row (review #80)', () => {
    const out = validateEmitShape({
      title: 't',
      question: '',
      blocks: [
        { type: 'facts', items: [{ term: 'x', ref: { resultId: 'R1', row: 1.5, col: 'c' } }] },
      ],
    });
    expect(out.ok).toBe(false);
  });
});

describe('EMIT_REPORT_JSON_SCHEMA', () => {
  it('is an object schema requiring title/question/blocks', () => {
    expect(EMIT_REPORT_JSON_SCHEMA.type).toBe('object');
    expect(EMIT_REPORT_JSON_SCHEMA.required).toEqual(['title', 'question', 'blocks']);
  });
});
