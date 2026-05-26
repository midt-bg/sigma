export * from './schema';
export * from './queries';

import type { RiskScoreRow, TenderRow } from './schema';

export async function getTenderById(db: D1Database, id: string): Promise<TenderRow | null> {
  return db.prepare('SELECT * FROM tenders WHERE id = ?1').bind(id).first<TenderRow>();
}

export async function listRecentTenders(
  db: D1Database,
  limit = 50,
  cpvDivision: string | null = null,
): Promise<TenderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tenders
       WHERE (?2 IS NULL OR substr(cpv_code, 1, 2) = ?2)
       ORDER BY published_at DESC LIMIT ?1`,
    )
    .bind(limit, cpvDivision)
    .all<TenderRow>();
  return results;
}

export interface SectorBreakdownRow {
  division: string; // 2-digit CPV division
  contracts: number;
  value_eur: number;
}

// Contract count + clean EUR per CPV division — the data side of the sector facet (@sigma/config
// maps division → label). Sector is derived from the tender CPV, so there is no sector column.
export async function sectorBreakdown(db: D1Database): Promise<SectorBreakdownRow[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(t.cpv_code, 1, 2) AS division, COUNT(*) AS contracts,
              COALESCE(SUM(c.amount_eur), 0) AS value_eur
       FROM contracts c JOIN tenders t ON t.id = c.tender_id
       WHERE t.cpv_code IS NOT NULL AND t.cpv_code <> ''
       GROUP BY division ORDER BY value_eur DESC`,
    )
    .all<SectorBreakdownRow>();
  return results;
}

export async function upsertRiskScore(db: D1Database, row: RiskScoreRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO risk_scores (tender_id, score, band, signals, computed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(tender_id) DO UPDATE SET
         score = excluded.score,
         band = excluded.band,
         signals = excluded.signals,
         computed_at = excluded.computed_at`,
    )
    .bind(row.tender_id, row.score, row.band, row.signals, row.computed_at)
    .run();
}
