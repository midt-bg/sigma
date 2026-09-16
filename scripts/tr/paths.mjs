// Paths and path sanitizers for the Търговски регистър leg (issue #279, ADR-0033, ADR-0041).
//
// Everything this leg writes lives under scratch/tr/, git-ignored, behind the same refuse-to-run rail
// the CACBG crawl uses (ADR-0010 decision 6):
//
//   scratch/tr/tr-cache.sqlite    the verdicts — ЕИК, dates, codes, booleans. NO names.
//
// The constant below is only a DEFAULT for the CLI. Every function that touches the filesystem takes
// its path explicitly, so tests drive temp directories without mutating process state.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratchIgnored } from '../cacbg/guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TR_SCRATCH = path.join(ROOT, 'scratch', 'tr');
export const TR_DB = path.join(TR_SCRATCH, 'tr-cache.sqlite');

/** Refuse to run unless scratch/tr is git-ignored. Call before the first write. */
export function assertTrScratchIgnored() {
  assertScratchIgnored('tr');
}

// A bare ЕИК: 9 or 13 digits, nothing else. Deliberately NOT normalised — an ЕИК that needed normalising
// did not come from where we think it did, and silently repairing it is how you end up deciding a link
// against a different company.
const EIK_SHAPE = /^(?:\d{9}|\d{13})$/;

/**
 * Sanitize an ЕИК before it becomes a key.
 *
 * Returns the value VERBATIM — as a string, always. Bulgarian public bodies carry codes of exactly the
 * `000…` shape, so a numeric round-trip anywhere on this path silently rewrites the identifier and a
 * link is decided against somebody else's partida (R8).
 *
 * Shape only. Whether the code's CHECKSUM is valid is a different question with a different remedy —
 * conflating the two would report a real-but-invalid code as an attack.
 * @param {unknown} eik @returns {string}
 */
export function safeEik(eik) {
  const s = String(eik ?? '');
  if (!EIK_SHAPE.test(s)) throw new Error(`unsafe ЕИК: ${JSON.stringify(eik)}`);
  return s;
}
