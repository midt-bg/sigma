// Cron strings shared by wrangler.toml's `crons`, scheduled()'s routing branch (index.ts), and the
// cron-guard test. Kept in a dependency-free module (no `cloudflare:workers` / `.sql` text imports) so
// the guard test can import them under plain vitest without pulling in the Workflow runtime.
export const REFRESH_CRON = '0 */6 * * *';
// Monday 06:05 UTC — deliberately :05, NOT :00. The 6-hourly REFRESH_CRON (00/06/12/18) already
// regenerates the starter prompts at the end of every run (index.ts's refresh-suggested-prompts step),
// so PROMPTS_CRON is only the coarse weekly fallback for a refresh whose best-effort regen kept failing.
// At exactly '0 6 * * 1' it would fire CONCURRENTLY with the Monday 06:00 refresh — two
// generateSuggestedPrompts runs racing on the same D1 (idempotent per-slot upserts, so no corruption,
// just wasted compute + last-write-wins on refreshed_at). Offsetting by 5 minutes makes it run just
// AFTER that refresh, which is what a fallback should do, and keeps it clear of every refresh slot (:00).
export const PROMPTS_CRON = '5 6 * * 1';
// Weekly Digest producer (#167A T3) — Monday 07:00 UTC, ~an hour after PROMPTS_CRON, so the digest's
// weekly queries run against the same freshly-refreshed slice the starter prompts just rebuilt from.
export const DIGEST_CRON = '0 7 * * 1';
