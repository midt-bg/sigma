/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPTS_CRON, REFRESH_CRON } from './crons';

// Routing safety: scheduled() branches on controller.cron against the named constants. A typo in
// wrangler.toml's `crons` (or in the constants) would silently misroute a trigger, so this parses the
// committed `crons` array and asserts it equals exactly [REFRESH_CRON, PROMPTS_CRON] — a mismatch
// fails CI instead of misfiring in production.

const wranglerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.toml');

function parseCrons(toml: string): string[] {
  const match = toml.match(/crons\s*=\s*\[([^\]]*)\]/);
  const inner = match?.[1];
  if (inner === undefined) throw new Error('no `crons = [...]` array found in wrangler.toml');
  return [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
}

describe('cron routing guard', () => {
  it('wrangler crons equal [REFRESH_CRON, PROMPTS_CRON] in order', () => {
    const crons = parseCrons(readFileSync(wranglerPath, 'utf8'));
    expect(crons).toStrictEqual([REFRESH_CRON, PROMPTS_CRON]);
  });
});
