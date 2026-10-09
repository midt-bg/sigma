// Pure inspector logic for /overruns — kept out of the route component so it is unit-testable and never
// fabricates. Two concerns: deriving a contract's status badge from a REAL term date, and grouping the
// pre-fetched annex rows per contract (assigning the „Анекс N" sequence) for O(1) lookup on selection.

import type { OverrunAnnex } from '@sigma/db';

export type ContractStatus = 'active' | 'closed';

/** Human label for the status badge (Bulgarian). */
export const STATUS_LABEL: Record<ContractStatus, string> = {
  active: 'В изпълнение',
  closed: 'Приключен',
};

// Derive the status badge ONLY from a real term/end date. A valid end date in the past → „Приключен";
// a valid end date today or in the future → „В изпълнение". No reliable date → null, and the caller
// omits the badge entirely (we never invent a status). `now` is injectable for deterministic tests.
export function contractStatus(
  endDate: string | null | undefined,
  now: Date = new Date(),
): ContractStatus | null {
  if (!endDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(endDate);
  if (!m) return null;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(end)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return end < today ? 'closed' : 'active';
}

export interface AnnexEntry {
  /** 1-based position within the contract's history, by date — the „Анекс N" label. */
  seq: number;
  date: string | null;
  reason: string | null;
  deltaEur: number | null;
}

// Group flat annex rows (already date-ordered per contract by the SQL) into per-contract lists, assigning
// the 1-based „Анекс N" sequence in arrival order. Returns a plain object so it serialises across the
// loader boundary; the inspector reads `grouped[contractId]` for the selected row.
export function groupAnnexes(rows: OverrunAnnex[]): Record<string, AnnexEntry[]> {
  const out: Record<string, AnnexEntry[]> = {};
  for (const r of rows) {
    const list = (out[r.contractId] ??= []);
    list.push({
      seq: list.length + 1,
      date: r.date,
      reason: r.reason,
      deltaEur: r.deltaEur,
    });
  }
  return out;
}
