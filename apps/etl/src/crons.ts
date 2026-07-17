// Cron strings shared by wrangler.toml's `crons`, scheduled()'s routing branch (index.ts), and the
// cron-guard test. Kept in a dependency-free module (no `cloudflare:workers` / `.sql` text imports) so
// the guard test can import them under plain vitest without pulling in the Workflow runtime.
export const REFRESH_CRON = '0 */6 * * *';
export const PROMPTS_CRON = '0 6 * * 1';
