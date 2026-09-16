import {
  BASE_AMENDMENT_COLS,
  BASE_CONTRACT_COLS,
  BASE_TENDER_COLS,
  type BaseCategory,
  type BaseStagingRow,
} from './base';
import {
  AMENDMENT_STAGING_COLS,
  CONTRACT_STAGING_COLS,
  LOT_STAGING_COLS,
  PARTY_STAGING_COLS,
  type AmendmentStagingRow,
  type ContractStagingRow,
  type LotStagingRow,
  type PartyStagingRow,
} from './ocds';

const CHUNK = 100;

type StagingRow =
  | ContractStagingRow
  | AmendmentStagingRow
  | PartyStagingRow
  | LotStagingRow
  | BaseStagingRow;

/** Where one mapped row set lands: the raw table and its insert column list. */
export interface StagingTarget {
  table: string;
  cols: readonly string[];
}

export const OCDS_STAGING = {
  contracts: { table: 'raw_contracts', cols: CONTRACT_STAGING_COLS },
  amendments: { table: 'raw_amendments', cols: AMENDMENT_STAGING_COLS },
  parties: { table: 'raw_ocds_parties', cols: PARTY_STAGING_COLS },
  lots: { table: 'raw_ocds_lots', cols: LOT_STAGING_COLS },
} satisfies Record<string, StagingTarget>;

export const BASE_STAGING: Record<BaseCategory, StagingTarget> = {
  contracts: { table: 'raw_contracts', cols: BASE_CONTRACT_COLS },
  tenders: { table: 'raw_tenders', cols: BASE_TENDER_COLS },
  annexes: { table: 'raw_amendments', cols: BASE_AMENDMENT_COLS },
};

/** Scoped DELETE + batched INSERT into one staging target for one source tag. */
export async function upsertStagingRows<T extends StagingRow>(
  db: D1Database,
  { table, cols }: StagingTarget,
  source: string,
  rows: T[],
): Promise<number> {
  const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE source = ?`).bind(source);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  if (rows.length === 0) {
    await db.batch([deleteStmt]);
    return 0;
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const stmts = rows.slice(i, i + CHUNK).map((r) => {
      const record = r as Record<string, unknown>;
      return db.prepare(sql).bind(...cols.map((c) => record[c] ?? null));
    });
    if (i === 0) stmts.unshift(deleteStmt);
    await db.batch(stmts);
  }
  return rows.length;
}
