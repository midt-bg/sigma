# Runbook: suppressing a свързани-лица link (takedown / correction)

A contested, corrected, or legally-challenged link on the свързани-лица surface is removed by adding it to
the version-controlled suppression list. See [ADR-0031](../adr/0031-suppressions-version-controlled-fingerprinted.md)
for why this is a git list keyed on an HMAC fingerprint, not a DB row.

## Grounds that require a takedown

Two of these are specific to the Trade Register evidence (#279, ADR-0033) and are easy to miss, because
neither shows up as a bug: the pipeline is working correctly and the claim is still wrong.

- **A court-annulled entry (чл. 29 ЗТРРЮЛНЦ).** A registry entry set aside by a court is void, but the
  deed we cached may still carry it, and the rules that read it are unchanged — so a rules-version bump
  will NOT remove the link. This is an evidence-invalidation ground, and suppression is the mechanism.
- **A match against the wrong person (a namesake).** The register carries no ЕГН, so a three-name match
  inside one entity is strong evidence of identity but not proof. If the named official is not the person
  in the act, the link is a false public claim about them and must come down immediately — do not wait for
  a rules change or a re-crawl.
- The ordinary grounds are unchanged: a contested link under review, a correction the source has since
  published, or a legal challenge.

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

## Correcting a wrong INPUT (a different list — read this before reaching for a suppression)

Suppression keeps a *built* link out of the public surface. It is the wrong tool when the link should never
have been built at all — a misparsed declaration row, a stake attributed to the wrong filing, an entity
that was never declared. There you fix the input, and the link stops existing.

That removal still has to get past the monotonicity gate ([ADR-0033](../adr/0033-registry-evidence-replaces-name-distinctiveness.md)
decision 6), which hard-fails on a link that was published last run and is not published now. And you
cannot use a suppression to clear it: correcting the input unbuilds the link, so the fingerprint would
match nothing and `load.mjs` fails on the unmatched-entry rail instead. The two removals fail in opposite
directions, which is why there is a second list.

1. Compute the fingerprint exactly as above (same salt, same function, same `key_version`).
2. Append one line to `scripts/cacbg/link-corrections.jsonl`:

   ```json
   {"fp":"<hex>","key_version":"1","reason":"the declaration row was misparsed — <ticket ref>","signal_ref":"<url or id>","corrected_at":"2026-08-11"}
   ```

3. Land it **in the same PR as the input fix**. The loader flags that key in the pre-wipe snapshot and the
   audit reads it as a declared removal — printed, never silent, and attributed to this ground rather than
   flattened into "removed".

**An acknowledgement is one-shot. Delete the line in the next change.** Once the corrected link stops being
published it also stops appearing in the prior set, so the entry matches nothing and the build fails on the
same rail suppressions use. That is deliberate: a stale acknowledgement would sit in the list and silently
pre-clear a *future* disappearance of that same link — the exact regression the gate exists to catch, with
nobody having decided it.

Do not use this list to clear a removal you do not understand. If a published link vanished and you cannot
name why, that is the gate doing its job; find the cause.

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
new value, replace the file in one commit, and update **both** CI settings — but note they are different
kinds: `SUPPRESSION_SALT` is a repository **secret**, while `SUPPRESSION_KEY_VERSION` is a repository
**variable** (`${{ vars.SUPPRESSION_KEY_VERSION || '1' }}` in `related-persons-data.yml`). The version is
not sensitive — it is a counter — and looking for it under Secrets is a dead end during an incident.
Because the loader refuses any entry on a non-current `key_version`, a half-finished rotation fails the
build loudly instead of silently un-suppressing.

## Verifying a takedown actually worked

A takedown that silently failed looks exactly like one that succeeded: the entry sits in the list, the
build is green, and the link is still public. The list is applied at LOAD time, so nothing changes on the
served surface until the next data run ships — check the surface, not the commit.

1. **The loader saw it.** The run refuses an entry matching no built link (the B3 unused-entry rail), so a
   green run already proves the fingerprint matched something. A run that fails with „suppression matched
   NO link" means the `link_key` was wrong — a family link needs its `|family` suffix.
2. **The row is gone from the served D1**, which is the only copy a reader can reach:
   ```
   wrangler d1 execute "$SIGMA_D1_NAME" --remote \
     --command "SELECT status FROM interest_links WHERE link_key = '<key>'"
   ```
   Expect `suppressed`, or no row at all. Anything else means the ship did not carry the decision.
3. **The page is gone**, allowing for cache: the link's page must 404 and the official's page must not
   list it. `publicCache(3600)` means a reader can still see it for up to an hour after the write — if it
   is still there beyond that, the takedown did not land.
4. **It stays gone.** Re-run the next scheduled load and repeat step 2: the list is what makes a takedown
   survive a rebuild, and this is the only step that proves the survival rather than assuming it.
