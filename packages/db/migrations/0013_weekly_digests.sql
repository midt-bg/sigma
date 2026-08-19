-- Weekly Digest (#167) archive index: one row per ISO week the digest producer has run for,
-- so re-runs/backfills are idempotent (upsert on iso_week) and the assistant/report layer can list
-- past digests without re-deriving them from the live contracts table.
CREATE TABLE weekly_digests (
  iso_week     TEXT PRIMARY KEY,   -- ISO 8601 week, e.g. '2024-W03' (matches strftime('%G-W%V', ...))
  as_of        TEXT,               -- data_freshness 'admin' as_of at generation time
  refreshed_at TEXT,               -- when this digest was (re)computed
  status       TEXT,               -- 'ok' | 'partial' | ... (producer-defined; not DB-enforced)
  total_eur    REAL                -- SUM(amount_eur) for the week (clean rows only) — headline figure
);
