// Paths and path sanitizers for the Търговски регистър leg (issue #279, ADR-0033).
//
// Everything this leg writes lives under scratch/tr/, git-ignored, behind the same refuse-to-run rail
// the CACBG crawl uses — a deed carries third-party personal data (owner and manager names, the
// company's street address), so it is ADR-0010 decision 6 territory, extended by ADR-0033 to a second
// source with a stated retention.
//
//   scratch/tr/deeds/<eik>.json   raw response, atomic write
//   scratch/tr/tr-cache.sqlite    the index — ЕИК, dates, codes, verdicts. NO names.
//
// The constants below are only DEFAULTS for the CLI. Every function that touches the filesystem takes
// its path explicitly, so tests drive temp directories without mutating process state.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratchIgnored } from '../cacbg/guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TR_SCRATCH = path.join(ROOT, 'scratch', 'tr');
export const TR_RAW = path.join(TR_SCRATCH, 'deeds');
export const TR_DB = path.join(TR_SCRATCH, 'tr-cache.sqlite');

/** Refuse to run unless scratch/tr is git-ignored. Call before the first fetch. */
export function assertTrScratchIgnored() {
  assertScratchIgnored('tr');
}

// A bare ЕИК: 9 or 13 digits, nothing else. Deliberately NOT `path.basename`-normalised — an ЕИК that
// needed normalising did not come from where we think it did, and silently repairing it is how you end
// up fetching a different company's deed.
const EIK_SHAPE = /^(?:\d{9}|\d{13})$/;

/**
 * Sanitize an ЕИК before it becomes a path segment or a URL segment.
 *
 * Returns the value VERBATIM — as a string, always. Bulgarian public bodies carry codes of exactly the
 * `000…` shape, so a numeric round-trip anywhere on this path silently rewrites the identifier and the
 * crawler fetches somebody else's deed (R8).
 *
 * Shape only. Whether the code's CHECKSUM is valid is a different question with a different remedy,
 * answered by eik.mjs — conflating the two would report a real-but-invalid code as a path attack.
 * @param {unknown} eik @returns {string}
 */
export function safeEik(eik) {
  const s = String(eik ?? '');
  if (!EIK_SHAPE.test(s)) throw new Error(`unsafe ЕИК: ${JSON.stringify(eik)}`);
  return s;
}

/** Absolute path of the cached raw deed for an ЕИК, under `rawDir` (default TR_RAW). */
export function deedPath(eik, rawDir = TR_RAW) {
  return path.join(rawDir, `${safeEik(eik)}.json`);
}
