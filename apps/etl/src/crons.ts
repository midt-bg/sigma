// Cron strings shared by wrangler.toml's `crons`, scheduled()'s routing branch (index.ts), and the
// cron-guard test. Kept in a dependency-free module (no `cloudflare:workers` / `.sql` text imports) so
// the guard test can import them under plain vitest without pulling in the Workflow runtime.
export const REFRESH_CRON = '0 */6 * * *';
export const PROMPTS_CRON = '0 6 * * 1';
// Weekly Digest producer (#167A T3) — Monday 07:00 UTC, an hour after PROMPTS_CRON, so the digest's
// weekly queries run against the same freshly-refreshed slice the starter prompts just rebuilt from.
export const DIGEST_CRON = '0 7 * * 1';
