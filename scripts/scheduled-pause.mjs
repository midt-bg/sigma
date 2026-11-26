#!/usr/bin/env node
// Hold the ETL's scheduled starts — the six-hourly refresh and register, the daily declarations tick — for a
// slot switch, an incident or a risky deploy, without a deploy (docs/deploy.md, „Пауза на графика“).
//
//   node scripts/scheduled-pause.mjs show  <bucket>
//   node scripts/scheduled-pause.mjs set   <bucket> --hours <1–168> --reason "<why>"
//   node scripts/scheduled-pause.mjs clear <bucket>
//
// <bucket> is the environment's declarations bucket (production `sigma-declarations`, staging
// `sigma-declarations-stage`): it belongs to the environment, not to a slot, so a hold survives a blue/green
// switch. The ETL reads apps/etl/src/pause.ts's key before every scheduled start. A run an operator triggers
// by hand (`wrangler workflows trigger`) is not held. Every hold ends by itself: `set` requires the hours.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Mirrors SCHEDULED_PAUSE_KEY in apps/etl/src/pause.ts. */
export const PAUSE_KEY = 'control/scheduled-pause.json';
/** Longer than a week is no longer a hold but a stopped pipeline: that is a deploy without the crons
 *  (docs/runbooks/release-rollback.md), which shows in the Worker's configuration instead of a bucket. */
export const MAX_HOURS = 168;

/** The object `set` writes. */
export function pauseBody({ hours, reason, now }) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    throw new Error(`--hours must be a whole number from 1 to ${MAX_HOURS}, got ${hours}`);
  if (!reason?.trim()) throw new Error('--reason is required: the paused tick logs it');
  const until = new Date(now.getTime() + hours * 3_600_000).toISOString();
  return { until, reason: reason.trim(), setAt: now.toISOString() };
}

/** What `show` prints for the stored object (null when there is none), read as the ETL reads it. */
export function describePause(text, now) {
  if (text === null) return 'no hold: the scheduled runs start as usual';
  let hold;
  try {
    hold = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    hold = null;
  }
  const until = Date.parse(hold?.until);
  if (Number.isNaN(until) || typeof hold?.reason !== 'string')
    return `not a valid hold, ignored by the ETL (which logs etl_scheduled_pause_ignored): ${text.trim()}`;
  if (until <= now.getTime())
    return `expired at ${hold.until}, no longer held (${hold.reason}); clear removes the object`;
  const minutes = Math.ceil((until - now.getTime()) / 60_000);
  return `HELD until ${hold.until} (${Math.floor(minutes / 60)} h ${minutes % 60} min left): ${hold.reason}`;
}

const missing = (error) =>
  /does not exist|NoSuchKey|not found/i.test(`${error?.message}${error?.stdout}${error?.stderr}`);

/**
 * The command, over an injected `wrangler(args, input)` that answers stdout and throws on failure, so every
 * path is tested without Cloudflare. Returns the lines to print.
 */
export function runPause(argv, { wrangler, now = new Date() }) {
  const [action, bucket, ...flags] = argv;
  const flag = (name) => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  if (!['show', 'set', 'clear'].includes(action) || !bucket || bucket.startsWith('-'))
    throw new Error(
      'usage: scheduled-pause.mjs show|set|clear <bucket> [--hours <1–168> --reason "<why>"]',
    );
  const object = `${bucket}/${PAUSE_KEY}`;
  if (action === 'set') {
    const body = pauseBody({ hours: Number(flag('--hours')), reason: flag('--reason'), now });
    wrangler(
      ['r2', 'object', 'put', object, '--remote', '--pipe', '--content-type', 'application/json'],
      JSON.stringify(body),
    );
    return [`${bucket}: ${describePause(JSON.stringify(body), now)}`];
  }
  if (action === 'clear') {
    wrangler(['r2', 'object', 'delete', object, '--remote']);
    return [`${bucket}: hold cleared, the next tick starts as usual`];
  }
  let text;
  try {
    text = wrangler(['r2', 'object', 'get', object, '--remote', '--pipe']);
  } catch (error) {
    if (!missing(error)) throw error;
    text = null;
  }
  return [`${bucket}: ${describePause(text, now)}`];
}

function main() {
  const wrangler = (args, input) =>
    execFileSync('pnpm', ['--filter', '@sigma/etl', 'exec', 'wrangler', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  for (const line of runPause(process.argv.slice(2), { wrangler })) console.log(line);
}

if (import.meta.main) main();
