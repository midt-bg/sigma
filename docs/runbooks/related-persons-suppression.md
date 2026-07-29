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
   {"fp":"<hex>","reason":"contested — <ticket/signal ref>","signal_ref":"<url or id>","suppressed_at":"2026-07-29"}
   ```

   `fp` is the only field the loader reads; the rest are the human audit trail. Do **not** put the raw
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

`load.mjs` aborts the build if `link-suppressions.jsonl` is non-empty but `SUPPRESSION_SALT` is unset —
fingerprinting without the salt would match nothing and silently re-expose every taken-down link. If a ship
fails with `SUPPRESSION_SALT is unset`, set the secret in the ship environment and re-run; do not empty the
list to get past it.

## Rotating the salt

A rotated salt invalidates every existing fingerprint. To rotate: re-derive `fp` for each entry from its
original `link_key` under the new salt (you need the plaintext keys, kept out-of-band, e.g. in the incident
tickets), replace the file in one commit, and update the CI secret. Until both land, keep the old salt.
