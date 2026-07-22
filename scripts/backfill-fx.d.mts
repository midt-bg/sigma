// Type surface for the legacy-NULL FX backfill (#158 follow-up). The implementation is plain ESM
// (.mjs) because it runs directly under `node` with no build step; this declaration gives the
// TypeScript equivalence suite (packages/db/src/backfill-fx.test.ts) real types.

/** A read/write runner over the served DB: `query` returns rows, `exec` applies a script. Backed
 *  by the sqlite3 CLI or wrangler d1 in the CLI, and by node:sqlite in tests. */
export interface FxRunner {
  query: (sql: string) => Array<Record<string, unknown>>;
  exec: (sql: string) => void;
}

export interface FxDamageReport {
  /** damaged rows: foreign currency, NULL amount_eur, not value_suspect */
  total: number;
  byCurrency: Record<string, number>;
  rows: Array<Record<string, unknown>>;
  /** leftover refresh_touched_* tables: a prior repair/refresh died before its rollup refresh */
  interrupted: boolean;
}

export interface FxFetchOutcome {
  currency: string;
  start?: string;
  end?: string;
  /** rates inserted for this currency */
  loaded?: number;
  status: 'ok' | 'unsupported' | 'invalid' | 'error';
  detail?: string;
}

export interface FxBackfillSummary {
  repaired: number;
  /** rows still unpriced after the repair (no usable ECB rate) */
  remaining: Array<{
    id: unknown;
    contract_number: unknown;
    currency: unknown;
    signed_at: unknown;
  }>;
  fetched: FxFetchOutcome[];
  /** true when a prior interrupted run's stale rollups were healed first */
  healed: boolean;
  before: FxDamageReport;
}

export function reportFxDamage(runner: FxRunner): FxDamageReport;

/** The row-repair script (rates → flags → EUR columns); exported for the interruption tests. */
export function repairSql(): string;

export function backfillFx(
  runner: FxRunner,
  options: {
    fetchFn?: typeof fetch;
    fetchedAt: string;
    refreshSliceSql: string;
    api?: string;
  },
): Promise<FxBackfillSummary>;
