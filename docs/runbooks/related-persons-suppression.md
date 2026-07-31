# Runbook: suppressing a свързани-лица link (takedown / correction)

A contested, corrected, or legally-challenged link on the свързани-лица surface is removed by adding it to
the version-controlled suppression list. See [ADR-0031](../adr/0031-suppressions-version-controlled-fingerprinted.md)
for why this is a git list keyed on an HMAC fingerprint, not a DB row.

## What you need

- The exact `link_key`. Self links are `pid|eik`; a close-relative link is `pid|eik|family`. Get it from the
  work DB: `SELECT link_key FROM interest_links WHERE person_id=? AND eik=?;` (or from the incident report).
- The `SUPPRESSION_SALT` value (the CI secret). Required to compute the fingerprint. Never commit it.

## Standard takedown (applies on the next ship)

1. Compute the fingerprint (same function the loader uses):

   ```sh
   node -e "import('./scripts/cacbg/suppressions.mjs').then(m => \
     console.log(m.fingerprint(process.argv[1], process.env.SUPPRESSION_SALT)))" '<link_key>'
   ```

2. Append one line to `scripts/cacbg/link-suppressions.jsonl`:

   ```json
   {"fp":"<hex>","key_version":"1","reason":"contested — <ticket/signal ref>","signal_ref":"<url or id>","suppressed_at":"2026-07-29"}
   ```

   `fp` and `key_version` are the fields the loader reads (`key_version` must equal the current
   `SUPPRESSION_KEY_VERSION`, default `1`); the rest are the human audit trail. Do **not** put the raw
   `link_key`, the person's name, or the ЕИК in this file — the fingerprint is the whole point.

3. Open a PR. On merge, the next data-ship rebuilds with the link marked `status='suppressed'`, so it drops
   off every surface (leaderboard, official, company, per-link contracts, search, and the family aggregate).

## Urgent takedown (cannot wait for a ship)

For a live-exposure incident, suppress directly on the served D1 first, then file the git entry so the state
survives the next rebuild:

```sh
# 1. immediate stopgap on the served D1 (prod or the affected env)
wrangler d1 execute <DB> --remote \
  --command "UPDATE interest_links SET status='suppressed' WHERE link_key='<link_key>';"
```

Then do the Standard takedown steps above **in the same shift**. The direct UPDATE is undone by the next ship
(which rebuilds the table); only the git list makes it permanent.

## Fail-closed behaviour

`load.mjs` aborts the build (non-zero exit) on any of three conditions — each would otherwise silently
re-expose a taken-down link:

1. **No salt.** The list is non-empty but `SUPPRESSION_SALT` is unset (`SUPPRESSION_SALT is unset`).
2. **Unmatched entry.** A fingerprint matches **no** built link (`matched NO built link`) — e.g. the
   official's institution changed (so the `link_key` changed), the ЕИК was reformatted, or the salt is
   wrong. Every listed entry must correspond to exactly one live link; a stale one must be fixed or removed.
3. **Rotated key.** An entry's `key_version` ≠ the current `SUPPRESSION_KEY_VERSION` (`key_version`) — it was
   fingerprinted under a different salt and cannot match, so it is refused rather than silently ignored.

If a ship fails on any of these, fix the cause; do **not** empty the list or drop the entry to get past it.

## Rotating the salt

A rotated salt invalidates every existing fingerprint, so it is a coordinated change guarded by
`key_version`: re-derive `fp` for each entry from its original `link_key` under the new salt (you need the
plaintext keys, kept out-of-band, e.g. in the incident tickets), **bump every entry's `key_version`** to the
new value, replace the file in one commit, and update both CI secrets (`SUPPRESSION_SALT` and
`SUPPRESSION_KEY_VERSION`). Because the loader refuses any entry on a non-current `key_version`, a
half-finished rotation fails the build loudly instead of silently un-suppressing.
