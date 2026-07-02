// E3 — Guard A: default filters.
//
// When the assistant queries the contracts corpus it must apply the safe defaults deterministically,
// not at the model's discretion: exclude rows with no summable canonical amount (amount_eur IS NULL —
// the same row-set the rollups cover, so live aggregates reconcile against them), exclude synthetic
// tenders (procedure_type = 'неизвестна', headers we fabricated for orphan contracts), and
// reason about time by `signed_at` (when the deal was struck) rather than `published_at`. Each
// default can be explicitly opted out of, but every opt-out emits a callout line naming the risk, so
// the assumption is always surfaced to the reader. This module is pure: it produces the descriptor,
// the callout, and a parameterized SQL fragment the query layer appends — it never runs SQL.

export type DateField = 'signed_at' | 'published_at';

export interface DefaultFilterOptions {
  /**
   * Include rows with no summable canonical amount (`amount_eur IS NULL`). These are absent from the
   * rollups, so including them makes live aggregates diverge from E4's reconcile basis.
   */
  includeUnsummable?: boolean;
  /** Include synthetic tenders (procedure_type = 'неизвестна'). */
  includeSynthetic?: boolean;
  /** Reason about time by this column. Defaults to `signed_at`. */
  dateField?: DateField;
}

export interface DefaultFilterDescriptor {
  excludeNullAmount: boolean;
  excludeSynthetic: boolean;
  dateField: DateField;
}

export interface DefaultFilterResult {
  descriptor: DefaultFilterDescriptor;
  /** Qualified column to use for date ordering/range, e.g. `c.signed_at`. */
  dateColumn: string;
  /** Callout lines surfaced to the reader; defaults plus an explicit warning per opt-out. */
  callout: string[];
  /** Parameterized WHERE conditions (no leading WHERE) to AND into the contracts query. */
  sql: { fragment: string; params: unknown[] };
}

const SYNTHETIC_PROCEDURE = 'неизвестна';

const DATE_COLUMN: Record<DateField, string> = {
  signed_at: 'c.signed_at',
  published_at: 'c.published_at',
};

const CALLOUT_DEFAULT_NULL_AMOUNT =
  'По подразбиране са изключени договори без съпоставима канонична стойност (amount_eur липсва); те не се сумират и не са включени в обобщените тотали (rollups).';
const CALLOUT_DEFAULT_SYNTHETIC =
  'По подразбиране са изключени синтетични поръчки с неизвестна процедура.';
const CALLOUT_DEFAULT_SIGNED_AT = 'Времевият анализ е по дата на подписване (signed_at).';
const CALLOUT_OPTOUT_NULL_AMOUNT =
  'ВНИМАНИЕ: по изрично искане са включени договори без канонична стойност (amount_eur липсва); тези редове няма да се съгласуват с обобщените тотали (rollups).';
const CALLOUT_OPTOUT_SYNTHETIC =
  'ВНИМАНИЕ: по изрично искане са включени синтетични поръчки (неизвестна процедура).';
const CALLOUT_OPTOUT_PUBLISHED_AT =
  'ВНИМАНИЕ: по изрично искане времевият анализ е по дата на публикуване (published_at) вместо signed_at.';

/**
 * Resolve the default contract filters against an explicit opt-out set. Deterministic and pure.
 *
 * The emitted `sql.fragment` assumes the query aliases `contracts` as `c` and the joined `tenders`
 * as `t`. Every contract has a tender (`contracts.tender_id NOT NULL REFERENCES tenders`) and
 * `tenders.procedure_type` is `NOT NULL` ('неизвестна' for synthetic orphan headers), so the
 * synthetic-tender guard is a plain inequality that excludes only the `'неизвестна'` sentinel.
 */
export function applyDefaultFilters(options: DefaultFilterOptions = {}): DefaultFilterResult {
  const excludeNullAmount = options.includeUnsummable !== true;
  const excludeSynthetic = options.includeSynthetic !== true;
  const dateField: DateField = options.dateField ?? 'signed_at';

  const callout: string[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (excludeNullAmount) {
    // Match the rollup basis exactly (amount_eur IS NOT NULL). Corrected value_suspect rows carry a
    // non-NULL procEst amount and ARE summed in the rollups, so they must NOT be excluded here; only
    // truly unrecoverable rows (no procEst → NULL amount_eur) fall out. Constant predicate, no bind.
    conditions.push('c.amount_eur IS NOT NULL');
    callout.push(CALLOUT_DEFAULT_NULL_AMOUNT);
  } else {
    callout.push(CALLOUT_OPTOUT_NULL_AMOUNT);
  }

  if (excludeSynthetic) {
    // tenders.procedure_type is NOT NULL ('неизвестна' for synthetic orphan headers) and every
    // contract has a tender, so a plain inequality suffices — there is no NULL row to guard.
    conditions.push('t.procedure_type != ?');
    params.push(SYNTHETIC_PROCEDURE);
    callout.push(CALLOUT_DEFAULT_SYNTHETIC);
  } else {
    callout.push(CALLOUT_OPTOUT_SYNTHETIC);
  }

  callout.push(dateField === 'signed_at' ? CALLOUT_DEFAULT_SIGNED_AT : CALLOUT_OPTOUT_PUBLISHED_AT);

  return {
    descriptor: { excludeNullAmount, excludeSynthetic, dateField },
    dateColumn: DATE_COLUMN[dateField],
    callout,
    sql: { fragment: conditions.join(' AND '), params },
  };
}
