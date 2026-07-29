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

/** HMAC-SHA256(salt, link_key) as hex — the stable, non-reversible key for a suppression entry. */
export function fingerprint(linkKey, salt) {
  return createHmac('sha256', salt).update(linkKey).digest('hex');
}

/**
 * Read the JSONL suppression list → a Set of fingerprints to apply at load.
 * FAIL-CLOSED: a non-empty list with no salt throws. Building without the salt would compute fingerprints
 * that match nothing, silently un-suppressing every taken-down link — a libel regression. Refuse instead.
 * An absent or empty list needs no salt (nothing to fingerprint), so the common path stays friction-free.
 */
export function loadSuppressionFingerprints(listPath, salt) {
  const entries = existsSync(listPath)
    ? readFileSync(listPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  if (entries.length > 0 && !salt) {
    throw new Error(
      `${entries.length} suppression(s) in ${listPath} but SUPPRESSION_SALT is unset — refusing to build ` +
        `(would silently un-suppress contested links). Set SUPPRESSION_SALT and retry.`,
    );
  }
  return new Set(entries.map((e) => e.fp));
}
