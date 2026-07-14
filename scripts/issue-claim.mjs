// Issue-claim bot — pure decision logic for assign-issue.yml and stale-assignment-check.yml.
//
// All functions receive plain data (octokit responses already fetched) and return decisions.
// The workflows are I/O glue: fetch → call pure fn → write result.
// This mirrors the reap-previews.mjs boundary exactly.
//
// No octokit import; no external deps — node built-ins only.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// ── Constants ─────────────────────────────────────────────────────────────────

export const IN_PROGRESS = 'status: in-progress';
export const NUDGE_DAYS = 14;
export const RELEASE_DAYS = 21;
export const NUDGE_MARKER = '<!-- sigma-nudge -->';
export const RELEASE_MARKER = '<!-- sigma-release -->';

// MARKER: the invisible HTML comment that records the claim payload.
// BANNER: the visible heading line that attributes the claim to the user.
// Both use GLOBAL regexes so stripClaim removes ALL occurrences — S3 anti-spoof.
const MARKER_RE = /<!--\s*sigma-claim:[^>]*-->/g;
const BANNER_RE = /^\*\*🔧 Claimed by:\*\* @[A-Za-z0-9-]{1,39}\n?/gm;

// GitHub username: 1–39 alphanumeric or hyphens, no leading/trailing hyphen per spec.
// We accept any sequence matching /^[A-Za-z0-9-]{1,39}$/ as a safe allowlist — S5.
const USERNAME_RE = /^[A-Za-z0-9-]{1,39}$/;

// ── parseCommand ──────────────────────────────────────────────────────────────

/**
 * Parses a comment body and returns the first whitespace-delimited token if it
 * is exactly '/assign' or '/unassign'. Any other token (including '/assignee',
 * '/assign-me', '/assigned') returns null. Case-sensitive.
 *
 * @param {string | null | undefined} body
 * @returns {'/assign' | '/unassign' | null}
 */
export function parseCommand(body) {
  if (!body) return null;
  const token = body.trim().split(/\s+/)[0] ?? '';
  if (token === '/assign') return '/assign';
  if (token === '/unassign') return '/unassign';
  return null;
}

// ── parseClaimMarker ──────────────────────────────────────────────────────────

/**
 * Extracts and validates the claim marker embedded in an issue body.
 * Never throws — wraps JSON.parse in try/catch (S2).
 * Validates `user` against the GitHub username pattern (S5).
 *
 * @param {string | null | undefined} body
 * @returns {{ user: string } | null}
 */
export function parseClaimMarker(body) {
  if (!body) return null;
  // Reset lastIndex before exec (MARKER_RE is global; reset avoids stale state).
  MARKER_RE.lastIndex = 0;
  const match = MARKER_RE.exec(body);
  MARKER_RE.lastIndex = 0;
  if (!match) return null;
  // Extract the JSON payload between the first ':' and the closing '-->'.
  const raw = match[0].replace(/^<!--\s*sigma-claim:\s*/, '').replace(/\s*-->$/, '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed?.user !== 'string') return null;
  if (!USERNAME_RE.test(parsed.user)) return null;
  return { user: parsed.user };
}

// ── stripClaim ────────────────────────────────────────────────────────────────

/**
 * Returns body with ALL claim markers and ALL banner lines removed.
 * Uses global regexes — S3 anti-spoof (removes duplicates too).
 * Null-safe: returns '' for null/undefined input.
 *
 * @param {string | null | undefined} body
 * @returns {string}
 */
export function stripClaim(body) {
  const s = body ?? '';
  // Reset lastIndex before each replace (global regexes retain state across calls).
  MARKER_RE.lastIndex = 0;
  BANNER_RE.lastIndex = 0;
  return s.replace(BANNER_RE, '').replace(MARKER_RE, '').replace(/^\n+/, '');
}

// ── writeClaim ────────────────────────────────────────────────────────────────

/**
 * Returns the issue body with the claim banner and marker prepended, stripping
 * any prior claim first (idempotent — safe to call on an already-claimed body).
 *
 * Format:
 *   **🔧 Claimed by:** @<user>
 *
 *   <!-- sigma-claim: {"user":"<user>"} -->
 *   <stripped body>
 *
 * @param {string | null | undefined} body
 * @param {string} user
 * @returns {string}
 */
export function writeClaim(body, user) {
  const base = stripClaim(body);
  return `**🔧 Claimed by:** @${user}\n\n<!-- sigma-claim: ${JSON.stringify({ user })} -->\n${base}`;
}

// ── canUnassign ───────────────────────────────────────────────────────────────

/**
 * Returns true if the actor may release a claim.
 * Two cases:
 *   1. The actor is the original claimer (self-release).
 *   2. The actor is privileged (write/admin on the repo — resolved by the workflow, O6).
 *
 * @param {{ actor: string, claimedUser: string | null, privileged: boolean }} opts
 * @returns {boolean}
 */
export function canUnassign({ actor, claimedUser, privileged }) {
  return actor === claimedUser || privileged === true;
}

// ── computeIdleDays ───────────────────────────────────────────────────────────

/**
 * Returns the number of days since the last HUMAN (non-Bot) event in the timeline.
 * Bot events (actor.type === 'Bot') are excluded so a nudge comment from the bot
 * does not reset the idle clock (O1-adjacent).
 *
 * Timestamp is `e.created_at || e.submitted_at`. Unparseable timestamps are skipped.
 * Falls back to `Date.parse(createdAt)` when no human event is found.
 *
 * @param {{ timeline: object[] | null, createdAt: string, nowMs: number }} opts
 * @returns {number}
 */
export function computeIdleDays({ timeline, createdAt, nowMs }) {
  const events = timeline ?? [];
  let lastHumanMs = NaN;
  for (const e of events) {
    if (e?.actor?.type === 'Bot') continue;
    const ts = Date.parse(e?.created_at || e?.submitted_at);
    if (!Number.isFinite(ts)) continue;
    if (Number.isNaN(lastHumanMs) || ts > lastHumanMs) {
      lastHumanMs = ts;
    }
  }
  const baseline = Number.isFinite(lastHumanMs) ? lastHumanMs : Date.parse(createdAt);
  return (nowMs - baseline) / 86_400_000;
}

// ── hasOpenLinkedPr ───────────────────────────────────────────────────────────

/**
 * Returns true if the timeline contains a cross-reference to an open pull request.
 * Reads `state` directly off the event (event.source.issue.state) so fork-source
 * PRs are handled correctly without a second API call (O3).
 * Null-safe on source / issue / repository.
 *
 * @param {object[] | null} timeline
 * @returns {boolean}
 */
export function hasOpenLinkedPr(timeline) {
  if (!timeline) return false;
  return timeline.some(
    (e) =>
      e?.event === 'cross-referenced' &&
      e?.source?.issue?.pull_request != null &&
      e?.source?.issue?.state === 'open',
  );
}

// ── shouldNudge ───────────────────────────────────────────────────────────────

/**
 * Returns true if the issue should receive a nudge comment:
 *   - idleDays >= nudgeDays, AND
 *   - no prior nudge detected (defined as: no `commented` event whose body includes
 *     the invisible nudgeMarker string — O1).
 *
 * The release branch (idle >= RELEASE_DAYS) is decided in the workflow before
 * calling shouldNudge; this function only guards the nudge step.
 *
 * @param {{ idleDays: number, nudgeDays: number, timeline: object[] | null, nudgeMarker: string }} opts
 * @returns {boolean}
 */
export function shouldNudge({ idleDays, nudgeDays, timeline, nudgeMarker }) {
  if (idleDays < nudgeDays) return false;
  const events = timeline ?? [];
  const alreadyNudged = events.some(
    (e) => e?.event === 'commented' && typeof e?.body === 'string' && e.body.includes(nudgeMarker),
  );
  return !alreadyNudged;
}

// ── isMain guard ──────────────────────────────────────────────────────────────

/**
 * True iff this module is the Node.js entry point.
 * URL-safe (handles percent-encoded paths, spaces, non-ASCII).
 *
 * @param {string} importMetaUrl
 * @param {string | undefined} argvPath
 * @returns {boolean}
 */
export function isMain(importMetaUrl, argvPath) {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(resolve(argvPath)).href;
}

if (isMain(import.meta.url, process.argv[1])) {
  console.log('issue-claim.mjs: loaded as entry point. No CLI command implemented.');
}
