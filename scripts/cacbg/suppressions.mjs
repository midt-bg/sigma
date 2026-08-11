// Version-controlled link suppression list (ADR-0031). A contested/corrected/taken-down свързани-лица link
// MUST stay removed across every refresh — including a fresh-CI-runner data-ship, which rebuilds the work DB
// from scratch and so cannot inherit a suppression that lived only in a mutable DB table. The list therefore
// lives in git (scripts/cacbg/link-suppressions.jsonl) and is applied at load time.
//
// The list is keyed on an HMAC-SHA256 fingerprint of link_key — NOT the raw `pid|eik` — so the repo never
// records WHO was taken down for WHICH company (a defamation-sensitive fact that would otherwise sit in git
// history forever). The HMAC key is a CI secret (SUPPRESSION_SALT), so a repo reader cannot reverse a
// fingerprint back to a person. The salt is needed only where links are BUILT (load/ship); the served D1
// stores just status='suppressed' and never sees the salt or the list.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// The key version the current SUPPRESSION_SALT corresponds to. Every list entry records the version it was
// fingerprinted under; a mismatch is refused (a rotated salt must re-fingerprint every entry, never leave a
// silent no-match). Bump both this default (via the env) and every entry's key_version when the salt rotates.
export const SUPPRESSION_KEY_VERSION = process.env.SUPPRESSION_KEY_VERSION ?? '1';

/** HMAC-SHA256(salt, link_key) as hex — the stable, non-reversible key for a suppression entry. */
export function fingerprint(linkKey, salt) {
  return createHmac('sha256', salt).update(linkKey).digest('hex');
}

/**
 * Read the JSONL suppression list → the entries to apply at load. Each entry is
 * `{ fp, key_version, reason, suppressed_at }`. FAIL-CLOSED — every failure below would otherwise SILENTLY
 * un-suppress a taken-down, defamation-sensitive link (a libel regression), so each throws instead:
 *   1. a non-empty list with no salt → fingerprints would match nothing;
 *   2. an entry whose key_version ≠ the current one → it was fingerprinted under a rotated salt, so it can
 *      never match — rotation must re-fingerprint every entry, not leave one on the old key.
 * The THIRD guard (a fingerprint matching NO built link — a changed institution / reformatted ЕИК) is
 * enforced by the caller, which tracks which fingerprints were used and fails on any that were not.
 * An absent or empty list needs no salt (nothing to fingerprint), so the common path stays friction-free.
 */
export function loadSuppressions(listPath, salt, keyVersion = SUPPRESSION_KEY_VERSION) {
  return loadFingerprintedList(listPath, salt, keyVersion, 'suppression');
}

/**
 * The MONOTONICITY-gate twin (ADR-0033 decision 6): links whose removal is licensed because their
 * INPUT was wrong, not because the rules changed.
 *
 * A separate list from the suppressions, because the two are not the same act and cannot share one.
 * A suppression keeps a built link OUT of the public surface; a correction says the link should never
 * have been built at all — so correcting the input unbuilds it, and a suppression on it would then
 * match nothing and trip the B3 unused gate. Same fingerprinting for the same reason: the raw
 * `pid|eik` records which named official was tied to which company, which is precisely what must not
 * live in git history. Consumed by load.mjs, which flags the matching keys in the pre-wipe snapshot.
 */
export function loadCorrections(listPath, salt, keyVersion = SUPPRESSION_KEY_VERSION) {
  return loadFingerprintedList(listPath, salt, keyVersion, 'correction');
}

function loadFingerprintedList(listPath, salt, keyVersion, label) {
  const entries = existsSync(listPath)
    ? readFileSync(listPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  if (entries.length > 0 && !salt) {
    throw new Error(
      `${entries.length} ${label}(s) in ${listPath} but SUPPRESSION_SALT is unset — refusing to build ` +
        `(would silently un-suppress contested links). Set SUPPRESSION_SALT and retry.`,
    );
  }
  for (const e of entries) {
    if (String(e.key_version ?? '') !== String(keyVersion)) {
      throw new Error(
        `${label} ${String(e.fp ?? '').slice(0, 12)}… has key_version ${JSON.stringify(e.key_version)} ` +
          `but the current SUPPRESSION_KEY_VERSION is ${keyVersion} — refusing to build (a rotated salt ` +
          `would silently un-suppress it). Re-fingerprint every entry under the current salt + key_version.`,
      );
    }
  }
  return entries;
}
