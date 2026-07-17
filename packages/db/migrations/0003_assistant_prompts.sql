-- Starter-prompt cache for the assistant dock empty state. etl-owned: ONE writer (sigma-etl weekly
-- cron, apps/etl/src/suggested-prompts.ts), ONE reader (apps/web loader assistant.prompts.tsx).
-- Renumbered from a duplicate 0001 ordinal → 0003; IF NOT EXISTS keeps re-apply a no-op on any DB that
-- already ran the former 0001_assistant_prompts.sql.
CREATE TABLE IF NOT EXISTS assistant_prompts (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),  -- 1..4 (DB-side bound; the loader also limits)
  label TEXT NOT NULL,                -- display text (escaped at render; may include sanitized authority name)
  send_query TEXT NOT NULL,           -- server-authored question POSTed on click — NEVER a raw feed name
  signal TEXT NOT NULL,
  as_of TEXT NOT NULL, window_from TEXT, window_to TEXT,
  refreshed_at TEXT NOT NULL
);
