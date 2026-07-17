import { data } from 'react-router';
import type { Route } from './+types/assistant.prompts';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';

// Resource route powering the assistant dock empty state (/assistant/prompts). Read-only, public, and
// best-effort: it serves whatever the weekly etl cron (apps/etl/src/suggested-prompts.ts) last wrote
// to `assistant_prompts`. ONE reader (here), ONE writer (that cron). The dock falls back to its static
// FALLBACK_PROMPTS when this returns an empty list, so any failure — including the table not existing
// yet during deploy/migrate lag — must degrade to `{ prompts: [], asOf: null, window: null }`, never a
// 500 or a leaked stack.

interface PromptRow {
  slot: number;
  label: string;
  send_query: string;
  as_of: string;
  window_from: string | null;
  window_to: string | null;
}

interface PromptsPayload {
  prompts: { label: string; send: string }[];
  asOf: string | null;
  window: { from: string | null; to: string | null } | null;
}

const EMPTY: PromptsPayload = { prompts: [], asOf: null, window: null };

export async function loader({ context }: Route.LoaderArgs) {
  let payload: PromptsPayload = EMPTY;
  try {
    const result = await withDbRetry(() =>
      context.cloudflare.env.DB.prepare(
        // Bounds: (1) the 4 known slots (defence-in-depth alongside the migration's CHECK), so this
        // public + edge-cached route can never echo more than the intended rows; (2) only rows the weekly
        // cron refreshed in the last 14 days — a slot that stops qualifying (so the cron stops UPSERTing
        // it) ages out instead of serving a stale value forever, and a stalled cron degrades to the
        // static fallback after ~2 cycles rather than serving indefinitely-old prompts.
        "SELECT slot, label, send_query, as_of, window_from, window_to FROM assistant_prompts WHERE slot BETWEEN 1 AND 4 AND refreshed_at > datetime('now', '-14 day') ORDER BY slot LIMIT 4",
      ).all<PromptRow>(),
    );
    const rows = result.results ?? [];
    const first = rows[0];
    payload = {
      prompts: rows.map((r) => ({ label: r.label, send: r.send_query })),
      asOf: first?.as_of ?? null,
      window: first ? { from: first.window_from, to: first.window_to } : null,
    };
  } catch (error) {
    // Best-effort: never surface a 500. Log so the otherwise-silent miss is visible in Workers logs.
    console.warn(
      '[assistant.prompts] read failed, serving empty:',
      error instanceof Error ? error.message : error,
    );
    payload = EMPTY;
  }
  return data(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': publicCache(900),
    },
  });
}
