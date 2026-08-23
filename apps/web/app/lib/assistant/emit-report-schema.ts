// emit_report shape validation + the model-facing JSON Schema.
//
// Two-stage validation of what the model emits (spec §4: "invalid output → the model retries"):
//   1. validateEmitShape (here)   — is it STRUCTURALLY a valid EmitReportInput? (block types, required
//      fields). Hand-rolled so it stays dependency-free and unit-testable.
//   2. bindReport (report-schema) — do the result-handle REFERENCES resolve, and re-bind real values.
// The JSON Schema is the contract handed to the model via the tool definition (the AI SDK can take a
// zod schema or this JSON Schema). Pure — no deps/bindings.

import type { CellFormat, CellRef, EmitReportInput } from './report-schema';

const FORMATS = new Set<CellFormat>(['money', 'number', 'percent', 'date', 'text']);
const BLOCK_TYPES = new Set([
  'text',
  'callout',
  'totals',
  'facts',
  'table',
  'bar',
  'flows',
  'timeseries',
]);

const ENTITY_KINDS = new Set(['company', 'authority', 'contract']);

// Upper bounds on model-emitted array sizes. bindReport sanitises/scans every block, item and column,
// and result rows are byte-capped upstream — but nothing bounded the array LENGTHS, so a very long (or
// non-LLM) emission would scan an unbounded structure. These ceilings are far above any real report
// (review follow-up).
const MAX_BLOCKS = 100;
const MAX_ITEMS = 50;
const MAX_COLUMNS = 50;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
// row indices are 0-based, non-negative INTEGERS. A non-integer (1.5) slips bindReport's `row < length`
// range check, then `rows[1.5]` is undefined and the slot silently binds null (review #80).
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isFormat = (v: unknown): v is CellFormat => isStr(v) && FORMATS.has(v as CellFormat);
// Optional fields: absent OR null count as "not given" — `null` for an optional key is a common
// model habit, and rejecting it turned a previously fine report into a retry for a value nothing
// consumes. bindReport folds null to absent on the rebuild.
const absent = (v: unknown): boolean => v === undefined || v === null;
// A table column's optional horizontal alignment. Whitelisted here so an out-of-enum value the type
// claims impossible ('left'|'right') cannot reach a renderer that interpolates it into an attribute
// or style (review follow-up).
const isAlign = (v: unknown): boolean => absent(v) || v === 'left' || v === 'right';
// A table column's optional entity link. `kind` must be a known EntityKind (it reaches entityHref,
// where an unknown kind silently builds a wrong-entity `/contracts/…` citation — review #80).
const isLink = (v: unknown): boolean =>
  absent(v) || (isObj(v) && isStr(v.kind) && ENTITY_KINDS.has(v.kind) && isNonEmptyStr(v.idCol));

function isCellRef(v: unknown): v is CellRef {
  return isObj(v) && isNonEmptyStr(v.resultId) && isIndex(v.row) && isNonEmptyStr(v.col);
}

export type ShapeResult = { ok: true; value: EmitReportInput } | { ok: false; errors: string[] };

/** Structurally validate a model-emitted report. On success the value is a typed EmitReportInput. */
export function validateEmitShape(input: unknown): ShapeResult {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['report must be an object'] };
  if (!isNonEmptyStr(input.title)) errors.push('title must be a non-empty string');
  if (!isStr(input.question)) errors.push('question must be a string');
  if (!Array.isArray(input.blocks)) {
    errors.push('blocks must be an array');
    return { ok: false, errors };
  }
  // Return before the per-block scan: an over-cap array is exactly the unbounded structure the ceiling
  // guards against, so validating it any further would do the scanning we mean to refuse (as for the
  // `!Array.isArray` guard above — review follow-up).
  if (input.blocks.length > MAX_BLOCKS) {
    errors.push(`blocks: at most ${MAX_BLOCKS}`);
    return { ok: false, errors };
  }

  input.blocks.forEach((b, i) => {
    const at = `block[${i}]`;
    if (!isObj(b) || !isStr(b.type) || !BLOCK_TYPES.has(b.type)) {
      errors.push(`${at}: invalid or missing "type"`);
      return;
    }
    const need = (cond: boolean, msg: string) => {
      if (!cond) errors.push(`${at} (${b.type as string}): ${msg}`);
    };
    // Shape + ceiling for a model-emitted array, returning the array ONLY when it is worth walking:
    // when over-cap, the length error is already recorded and scanning the oversized array is the
    // work the ceiling exists to refuse (review follow-up) — so the caller's per-element pass is
    // skipped (`?.forEach`). One helper, three arrays, identical semantics.
    const cappedArray = (
      v: unknown,
      max: number,
      noun: string,
      shapeMsg: string,
      nonEmpty = false,
    ): unknown[] | undefined => {
      need(Array.isArray(v) && (!nonEmpty || v.length > 0), shapeMsg);
      need(!Array.isArray(v) || v.length <= max, `at most ${max} ${noun}`);
      return Array.isArray(v) && v.length <= max ? v : undefined;
    };
    switch (b.type) {
      case 'text':
        need(isStr(b.md), 'md must be a string');
        break;
      case 'callout':
        need(isNonEmptyStr(b.title), 'title required');
        need(isStr(b.md), 'md must be a string');
        break;
      case 'totals':
        cappedArray(b.items, MAX_ITEMS, 'items', 'items must be an array')?.forEach((it, j) =>
          need(
            isObj(it) && isStr(it.label) && isCellRef(it.ref) && isFormat(it.format),
            `items[${j}] needs {label, ref:{resultId,row,col}, format}`,
          ),
        );
        break;
      case 'facts':
        cappedArray(b.items, MAX_ITEMS, 'items', 'items must be an array')?.forEach((it, j) =>
          // `sub` is optional prose: it must be a string (or absent) HERE, because bindReport hands it
          // to the prose gate, and a number/object there is a TypeError — an opaque tool error to the
          // model instead of this retryable message — and a number in `sub` is an unbound figure the
          // gate would otherwise never scan.
          need(
            isObj(it) && isStr(it.term) && isCellRef(it.ref) && (absent(it.sub) || isStr(it.sub)),
            `items[${j}] needs {term, ref, sub?:string}`,
          ),
        );
        break;
      case 'table':
        need(isNonEmptyStr(b.resultId), 'resultId required');
        cappedArray(
          b.columns,
          MAX_COLUMNS,
          'columns',
          'columns must be a non-empty array',
          true,
        )?.forEach((c, j) =>
          need(
            isObj(c) &&
              isNonEmptyStr(c.key) &&
              isStr(c.header) &&
              isAlign(c.align) &&
              isFormat(c.format) &&
              isLink(c.link),
            `columns[${j}] needs {key, header, align?:left|right, format, link?:{kind:company|authority|contract, idCol}}`,
          ),
        );
        break;
      case 'bar':
        need(isNonEmptyStr(b.resultId), 'resultId required');
        need(
          isNonEmptyStr(b.labelCol) && isNonEmptyStr(b.valueCol),
          'labelCol and valueCol required',
        );
        break;
      case 'flows':
        need(isNonEmptyStr(b.resultId), 'resultId required');
        need(
          isNonEmptyStr(b.fromCol) && isNonEmptyStr(b.toCol) && isNonEmptyStr(b.valueCol),
          'fromCol, toCol and valueCol required',
        );
        break;
      case 'timeseries':
        need(isNonEmptyStr(b.resultId), 'resultId required');
        need(
          isNonEmptyStr(b.periodCol) && isNonEmptyStr(b.valueCol),
          'periodCol and valueCol required',
        );
        break;
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: input as unknown as EmitReportInput };
}

// Model-facing contract for the emit_report tool. Kept pragmatic: it requires `type` and the common
// shape; validateEmitShape enforces the strict per-type rules server-side.
export const EMIT_REPORT_JSON_SCHEMA = {
  type: 'object',
  required: ['title', 'question', 'blocks'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Кратко заглавие на справката (на български)' },
    question: {
      type: 'string',
      description: 'Зададеният от потребителя въпрос (показва се на справката)',
    },
    blocks: {
      type: 'array',
      minItems: 1,
      description:
        'Блокове на справката. Числата НЕ се пишат тук — препращат към резултатни хендъли (ref:{resultId,row,col}) или resultId+колони; сървърът свързва стойностите.',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            enum: ['text', 'callout', 'totals', 'facts', 'table', 'bar', 'flows', 'timeseries'],
          },
        },
      },
    },
  },
} as const;
