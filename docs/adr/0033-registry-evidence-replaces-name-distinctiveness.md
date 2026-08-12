# ADR-0033: A link publishes only against a Trade Register fact — the evidence ladder replaces the name-distinctiveness tier

- Status: Accepted (design; implemented as the #279 pipeline change)
- Date: 2026-08-05
- Deciders: Todor (maintainer), Claude
- Supersedes: [ADR-0009](0009-name-uniqueness-guard-and-publish-tiers.md), [ADR-0015](0015-tr-name-uniqueness-census.md), [ADR-0017](0017-name-collision-tier-gate.md)
- Amends: [ADR-0007](0007-scope-and-certainty-bar.md) (decisions 2 and 3), [ADR-0010](0010-pii-posture.md) (decisions 3 and 6), [ADR-0021](0021-methodology-page-and-temporal-freshness.md) (E11 only — E10 stands and is strengthened), [ADR-0028](0028-declared-eik-is-a-determining-identifier.md)
- Related: [ADR-0008](0008-deterministic-name-to-eik-resolution.md), [ADR-0011](0011-host-scoped-tls-pinning.md), [ADR-0026](0026-person-grain-name-institution.md), [ADR-0027](0027-overmerge-gate-is-telemetry-not-a-gate.md), [ADR-0031](0031-suppressions-version-controlled-fingerprinted.md), [ADR-0032](0032-family-ownership-published-under-public-interest.md); spec §3.3/§5/§8/§9, [related-persons-lia.md](../spec/related-persons-lia.md); `scripts/tr/`, `scripts/cacbg/{load,classify}.mjs`, `packages/db/src/queries/related-persons.ts`, `apps/web/app/routes/conflict*.tsx`

## Context

Today the identity of the company behind a declared name is decided by a heuristic. `B_distinctive`
(ADR-0009) publishes a link when the name is *structurally* distinctive — a digit, a Latin token, or ≥3
content words. It fails in both directions: it publishes on a bare name coincidence, and it withholds
everything else. Of the 101 links published today, **36 rest on name coincidence alone**.

The Trade Register answers the identity question directly, over a public endpoint with no authentication:
`GET https://portal.registryagency.bg/CR/api/Deeds/{ЕИК}`. Either the declarant is named in the company's
live deed, or facts they declared match the ones registered against that ЕИК.

Four things must be on the table before the decision, because each of them changes what is being decided.

**1. This is an expansion, not a tightening.** The measured surface grows from 101 links to **329 links /
311 people / 239 companies**. „From held / published / withdrawn = 163 / 65 / 101" means **264 links we
deliberately withhold today become named public claims**. At 329 links a 1% error rate is three falsely
named people. The precision bar has to go **up**, not stay flat — which is why the acceptance gate below is
a hand-labelled sample and not the control totals.

**2. The second rung is a heuristic used to assert — stated precisely.** What the registry evidence
establishes is **the identity of the company**, not that the official owns it: the ownership claim comes
from the official's own filed declaration and is not a heuristic at all. Rung 2 („Документ") confirms that
*the company this declared name refers to is the same legal entity as the winner we matched*, by finding
the declarant's full name inside that company's live fields. A homonym failure therefore does not invent an
ownership claim — it **attaches the official to the wrong company's ЕИК, contracts and money**. That is a
different error from the one the adversarial reading suggests, and it is still a false public claim about a
named person.

A three-name subset match against free text, in a register that carries no ЕГН, is **not deterministic**.
ADR-0007's decision list rules it out twice: item 2 (published only when the official↔company↔ЕИК
resolution is *deterministic*) and item 3 (heuristics may *withhold* or *triage*, **never assert**). #279
replaces a weaker heuristic with a stronger one and promotes it to grounds for assertion. That is the
decision this ADR exists to make explicit; it cannot be smuggled in as an implementation detail.

**3. The shape of the access is the permitted one.** Spec §3.3 permits „bounded per-ЕИК … thousands, not
~900k" and forbids bulk scraping; ADR-0007 decision 1 already anticipated the „per-ЕИК lookup only, later
leg". The crawl is one lookup per candidate ЕИК — on the order of hundreds — with a closed candidate set:
the crawler never follows a link out of a deed. This is that later leg, not the bulk reuse.

**4. The endpoint rate-limits, and the limiter is a stated preference.** An earlier spike against this same
API triggered **HTTP 429 at roughly 50 cumulative requests ending in a burst**, and the block was then
*sustained* — every subsequent request returned 429, including simple `/Deeds/{eik}` calls that had worked
seconds earlier. There is no `Retry-After` and no `X-RateLimit-*` header, so a client can only avoid
tripping the limit, never pace against a published one; 25 spaced requests were fine, so pacing matters more
than total volume. #279 §3's „~400 companies, about 20 minutes" is therefore feasible only at its stated
1 request / 3 seconds with no burst, and only if the crawl is resumable. The limiter is the operator's only
available way to express a rate preference, and tuning around it empirically is precisely the posture spec
§3.3's „NEVER bulk-scrape" exists to forbid. This is the evidence behind decision 7's crawl hygiene.

**5. Parts of the source description in #279 were wrong, and were corrected by live probing** (9 sequential
requests, 2026-08-04 — well inside the pacing above, so no 429 was encountered):

- `?entryDate=<ISO>` **is** honoured — a bogus-parameter control returned byte-identical output to the
  plain request, so the difference is the parameter, not noise. `…/Fields/{ident}/History` **does** return
  JSON, not application HTML. #279 §3 states the opposite for both.
- A wrong `subUIC` yields **HTTP 500 `GL_ERROR_L`**, not 404 — so a 500 can never be read as „no history"
  or „outside the register".
- `legalForm` 4 = ООД and 10 = ЕООД (as #279 says); the nomenclature endpoint does **not** settle the enum
  — `legalForm=4` and `legalForm=10` return a byte-identical catalogue.
- The envelope's `fullName` carries the legal form (`"ПИМК" ООД`) while `CR_F_2_L` is bare. The joint-stock
  bar can therefore be derived from the ЗТРРЮЛНЦ-mandated suffix, at zero extra requests.
- Erasure is **structural, not textual**. Entities inside one field are separated by
  `<div class='record-container record-container--preview'>` blocks delimited by `<hr class='hr--report'/>`.
  An erased entity is such a block carrying an erasure marker. **Correction, on implementation:** this ADR
  first named that marker `field-text--erased`. Re-measured against the full live deed for ЕИК 115536179,
  that class occurs **zero** times; the register emits `<div class='erasure-text-inline'>` (with
  `<i class='ui-icon ui-icon-erased'>`) and the erased container carries **no `field-text` paragraph at
  all**. The parser therefore treats *either* spelling as erasure — honouring both costs nothing, while
  assuming one costs a wrong publish. `fieldOperation` is **not** the signal: it reads 2 on both erased
  fields in that deed but 1 on the erased history records W0 sampled, so it is an undocumented enum we do
  not rely on.
- Erased versions are **live in the current deed**: the first company sampled carries a fully-erased
  `CR_F_23_L` dated 2013-07-16, which read naïvely becomes „latest ownership entry: 2013-07-16" and feeds
  the refutation rule.
- Seats move. The same company's `CR_F_5_L` shows entry dates 2010-11-04 and 2014-01-23.
- **An ЕИК that is not a търговец answers `HTTP 200` with a ZERO-BYTE body** — not the 404, and not the
  HTML, that §3 predicts. Measured on Община София (`000696327`): empty on two consecutive requests,
  while a real company returned its full 34,398-byte deed in the same window, so it is the register's
  answer rather than an outage. This is what the „извън ТР" rung actually looks like on the wire. The
  distinction that keeps R6 honest is therefore the **status**, not the empty body: empty under 200 is
  a documented negative and may be cached permanently; empty under 5xx is a failure and stays transient.

The as-of capability that `?entryDate=` unlocks would fix the two weakest rungs, but it **re-baselines every
control number in #279 §10**. It is therefore deliberately out of scope here and becomes a separate change
under a new rules version — which decision 6 makes the only sanctioned way the surface may move.

## Decision

### 1. The evidence ladder replaces the publish tiers

For every resolved link (person × ЕИК) with a fetched deed, **the first matching rung wins**:

| # | Outcome (data label) | Condition | Effect |
|---|---|---|---|
| 1 | **„Бар: акционерна форма"** — joint-stock bar | the company is a joint-stock form (АД / ЕАД / КДА) | never published, whatever follows |
| 2 | **„Документ"** — documented | the declarant's full name appears in a live `CR_F_7_L` / `CR_F_18_L` / `CR_F_19_L` / `CR_F_23_L` | published; the role (owner vs manager only) is kept for the label |
| 3 | **„Потвърдено"** — confirmed | the normalized declared seat equals the registered seat for that ЕИК, **or** the declarant wrote the ЕИК in the declaration | published |
| 4 | **„Оборена"** — refuted | *own* stake only: the person appears in no live field, **and** the latest entry date across the live ownership fields is strictly before the first declared year | link withdrawn |
| 5 | **„Неизвестна"** — unknown | anything else | held |
| 6 | **„Извън ТР"** — outside the register | the ЕИК is not in the register (ДЗЗД, БУЛСТАТ associations) | held |

The Bulgarian labels are the persisted vocabulary — they reach the data, the audit and the methodology
page — so they are fixed here rather than translated at each layer.

Erased versions are skipped everywhere the live state is read — otherwise the date on an erased record can
„certify" a state that is not in force.

`publish_tier` carries the evidence kind. **`B_distinctive` leaves the publishing path entirely**;
name distinctiveness survives only as an ordering signal for the review queue. Rung 3's seat leg takes the
declared seat **only from declarations by the same person for the same company**: 4.9% of company-name keys
carry more than one distinct declared seat, so a company-only key would let one person's seat confirm
another person's link.

This supersedes ADR-0009 (the tier ladder) and ADR-0015 (the name census, whose only job was to unblock
`C_hold`; `tr-census.mjs` and its `promote()` are deleted). ADR-0028's holding survives — a declared ЕИК
*is* the identity — but it is now rung 3 rather than a tier of its own, it is subject to rung 1, and its
census-exemption clause is moot.

### 2. A heuristic may ground an assertion here — the argued exception to ADR-0007

Rung 2 asserts on a name match. We accept it, on these grounds and no wider:

- **It is a full-subset match, patronymic included.** Partial (2-of-3) matching is refused outright: of 301
  matches measured, 46 were two-token only — precisely the homonym risk. A declarant name with fewer than
  three tokens can never earn „Документ".
- **It is scoped to a single registry entity.** Tokens are matched only within one `record-container`
  block, after erased blocks are dropped and after HTML entities are decoded. Matching against a whole
  field's text would combine the given name of one person with the surname of another — the defect that
  ships a libel.
- **The company identity behind it passed preventive control.** The candidate ЕИК comes from the
  deterministic exact-name resolution of ADR-0008/#226, not from fuzzy matching.

  > **Superseded on this point by [ADR-0035](0035-registry-evidence-must-also-establish-the-company.md).**
  > Deterministic is not the same as correct: that resolution ranges over PROCUREMENT WINNERS only, so an
  > official whose real company never bid resolves to a same-named winner, and a homonym in the winner's
  > deed completes a link false in both halves. Rung 2 now requires a corroborator for the COMPANY —
  > declared ЕИК, a matching declared seat, or a distinctive фирма — and the uncorroborated remainder is
  > withheld as `document_uncorroborated` and counted.
- **It is corroborated, and that is the whole difference.** A bare TR name is spec §4's *weakest* join —
  no ЕГН, no birthdate, not even ADR-0026's `(name, ведомство)` grain. The registry-graph spike that
  explored this API concluded, for its own use, that no person-derived edge may reach a user-visible
  surface at all, and it named the one cheap corroborator that would change that: *an officer who also
  appears as a declarant with a declared stake in the same ЕИК, confirmed by an independent source*. That
  is exactly what rung 2 is. The register supplies the name-in-this-company fact; the official's own filing
  supplies the stake. Neither alone would publish. **The corroboration is what licenses the assertion, so
  the rule must never be extended to a name-only join** — matching a person across two companies, or
  treating a registry name as an identity in its own right, stays forbidden.
- **The filters that can only withhold are retained, not removed.** `nameGloballyUnique` and
  `nameDistinctiveness` stay in the pipeline as an **AND-gate on the weakest rung only** („Потвърдено").
  They cost near-zero recall and preserve ADR-0017's outcome even though its subject — the name-distinctive
  tier — is gone.
- **Homoglyphs are not folded.** `company-name-key.ts` deliberately does not fold Cyrillic↔Latin; person
  names take the same posture. A Latin letter inside a name means no „Документ", and the occurrence is
  counted rather than silently dropped.

**The residual collision rate is estimated, not measured, and we say so.** Bulgarian names are three-part
by statute (ЗГР чл. 9) and the API renders full triples consistently. A triple of common components —
Георги · Иванов · Петров — is on the order of 10⁻⁵ of ~3.2M men, so roughly 29 people nationally share it;
but the population that can produce a false link is company officers, a ~1% slice, which squares the
probability to ~10⁻⁴ per colliding pair. That is an argument for plausibility, not a measurement, and the
residual concentrates on exactly the common names. It is therefore **not** the basis on which this
publishes — the hand-labelled sample of decision 7 is. Hyphenated surnames count as one token; Latin-script
names are counted the same way but flagged, since a three-token foreign name is not a patronymic triple.

The tie-breaker for every rung is the repo's own sentence, from
`packages/shared/src/company-name-key.ts`: **„When in doubt the key stays MORE specific (a recall miss is
safe; an over-merge is not)."**

This **amends ADR-0007 decisions 2 and 3**: a published claim may now rest on a disclosed, bounded,
entity-scoped full-name match against a public register, in addition to deterministic facts. Everything
else in ADR-0007 stands — in particular that every heuristic is disclosed on the methodology page and
labelled in the data, which decision 7 makes a launch condition rather than a follow-up.

### 3. The joint-stock bar is a union of three independent signals

The bar exists because the shareholder book is not public (so the claim is unverifiable) and a parcel of
listed shares is not a material ownership conflict (the „11 Trace shares → €88M" trap). It fires if **any**
of the following says joint-stock:

1. `closelyHeldForm` on the **declared** name (`load.mjs`) — a different, earlier stage; it **stays**, and
   is not redundant with the two below;
2. the фирма suffix taken from the deed envelope's `fullName`, through that same tested predicate;
3. the numeric `legalForm` code from the deed.

**An unknown `legalForm` code withholds and is reported** — it never falls through to publication. The enum
is known only from four observed values and the nomenclature endpoint does not settle it (Context 5), so
fail-open here would be a bar that silently stops barring. `КДА` — which rung 1 explicitly requires barring
— is absent from both `JOINT_STOCK` and `FORM_TOKENS` in `classify.mjs` today and is added.

**The named open question is ЕАД.** #279 §3 lists 5 = АД, and the spike's catalogue-derived table also
reads 5 as АД/ЕАД jointly — but ООД and ЕООД turned out **not** to share a code (4 and 10), so a separate
ЕАД code is the likelier reading and no observation settles it. A single-owner joint-stock company is
precisely the shape a declarant is most likely to hold and rung 1 most needs to bar, so this is the one
place where a fail-open enum would do real damage. Signal 2 (the ЗТРРЮЛНЦ suffix on `fullName`) covers it
independently of the code, which is why the bar is a union and not a lookup.

### 4. Termination is reconciled against the live deed — reversing ADR-0021 E11 for own stakes

ADR-0021 E11 marks an ownership link `withdrawn` when the company is absent from the person's latest
ownership filing. That is an inference from silence, and its commonest cause is a finished mandate rather
than a sale. Before the withdrawal takes effect, every terminated **own** stake is reconciled against the
live deed: a person still named in a live ownership field (`CR_F_18/19/23_L`) has not divested, and the
link surfaces. Family stakes are never reconciled — the relative's name is neither stored nor checked
(ADR-0010 decision 4, ADR-0032 decision 2), so declared termination applies to them directly.

**Phase 1 uses the reconciliation only to avoid withdrawing the link.** The „и към днешна дата" labels of
#279 §7, and the post-period contracts they license, are **deferred to phase 2 behind an LIA addendum**:
those labels assert a present tense about a named person, on evidence whose freshness is bounded by the
cache refresh cycle, and they change the claim's shape enough to need the balancing assessment updated
first. The derived live status is therefore recomputed on every run and **never sealed**.

ADR-0021 **E10 is untouched and strengthened** — see decision 7.

### 5. The deed cache — amends ADR-0010

A deed contains third-party personal data: addresses of natural persons, and the names of people who are
not office holders.

- **Extraction stays inside ADR-0010 decision 3.** `CR_F_5_L` yields only the „Населено място:" segment;
  no parser function returns an address. Decision 3 is re-affirmed, not overridden.
- **Storage is what changes, and that is ADR-0010 decision 6.** Raw deeds are cached under git-ignored
  `scratch/tr/`, behind the same refuse-to-run guard as the declaration cache, with a **35-day retention**
  (one refresh cycle plus slack) and a purge step in the same job. Decision 6's scope extends from „raw
  declaration XML … deleted post-spike" to a second source with a stated TTL.
- **The cache index holds no name at all** — only ЕИК, dates, codes and verdicts, plus a body hash instead
  of any content excerpt. Names exist solely in the raw JSON files, are read only to produce a boolean, and
  never enter a public table, a response, or a log. ЕГН was absent from every payload examined, and the
  index additionally refuses any ten-digit run in a text column — sound because an ЕИК is 9 or 13 digits,
  never 10.
- **The deed's beneficial-ownership fields are deliberately not used.** A deed also carries `CR_F_550_L`
  (действителни собственици, чл. 63 ЗМИП) and the control fields `CR_F_537/538_L`. Using them would make a
  beneficial-ownership claim, which ADR-0007 decision 1 parked after CJEU C-37/20. Rung 2 reads the four
  fields #279 names and no others; widening it is a new decision, not an improvement.
- **The sealed `matched_fact` is a closed vocabulary** (`seat:<CITY>`, `role:owner:<FIELD>`, `eik`),
  enforced by a pattern check in the audit. Without that, the matched *name* eventually gets stored there
  as a convenience, which is exactly what #279 §9 forbids.

### 6. Monotonicity is a gate, not a store — and #279 §8 is corrected

#279 §8 requires the evidence seal to be kept „forever" and recomputation to be strictly additive. As
written that is false, and the implementation must not pretend otherwise:

- §7's labels flip. A person who leaves the register must lose the label *and* the post-period contracts it
  licensed. (Phase 1 avoids this by not shipping the labels at all — decision 4.)
- A permanent seal and a live, expiring cache contradict each other.
- A **court-annulled entry** (чл. 29 ЗТРРЮЛНЦ) invalidates the evidence without any rules change. It is
  wired to the correction path of ADR-0031 and named as a ground in the suppression runbook.

Therefore: seals are **re-derived deterministically** on every run — a seal is written for *every* link,
including held ones, so the review queue explains itself — and monotonicity is enforced as a **gate**. The
audit compares against the pre-wipe export and raises a hard finding when a previously published link
disappears under an **unchanged** `rules_version`; under a changed version it degrades to a printed diff.
Removal remains an intentional event, and each ground has an expressible mechanism — a gate that hard-fails
the only removals it sanctions is a deadlock, not a rail:

| Ground | Mechanism | Why not one of the others |
|---|---|---|
| The rules changed | a `rules_version` bump | — |
| The evidence is void (court annulment, wrong person) | ADR-0031 suppression — `status` flips to `suppressed`, so the audit reads the current status and treats it as declared | the link is correctly built; only its publication is wrong |
| The input was wrong | `scripts/cacbg/link-corrections.jsonl`, fingerprinted like the suppression list; `load.mjs` flags the key in the pre-wipe snapshot | correcting the input *unbuilds* the link, so a suppression on it matches nothing and trips the unused-entry rail |

Both non-rules grounds are one-shot, version-controlled, and reviewed in git; neither is silent — the audit
prints every declared removal with the ground that licensed it. An acknowledgement that matches nothing
fails the build, because a stale one would pre-clear a *future* disappearance of that same link.

### 7. Launch gates

None of these are follow-ups.

- **Precision is proven by a hand-labelled sample, not by the control totals.** A human verifies against the
  portal: every reconciled link, every refuted link, and random samples of „Документ" and „Потвърдено".
  **Pass mark: zero wrong-company and zero wrong-person errors.** The control numbers of #279 §10 are a
  reproducibility check, and two things had to be settled before they could serve as one.

  **The §5/§10 discrepancy is a dropped histogram category, not a disputed measurement.** §5's rungs carry
  their own control counts: 4 barred + 281 document + 102 seat + 3 ЕИК + 21 refuted + 156 unknown = 567,
  plus the 4 links whose ЕИК is not in the register at all (§5 scopes the ladder to links „с изтеглен акт",
  so those reach no rung) = **571**. §10's identity row is 281 / 102 / 156 / 21 / 4 / 4 = **568**. The
  difference is exactly the „3 по ЕИК".

  The cause is visible in the labels. The identity row names its second bucket **„седалище"** — one leg of
  rung 3 — while the evidence row two lines below names the same rung **„потвърдено"** (251 / 78). Rung 3
  has two legs; the row tallied one and presented the result as a partition of the resolved set. And the
  stated total 568 equals that row's sum exactly, which makes it a figure derived from the histogram rather
  than measured independently. So both move together: the bucket becomes **„потвърдено: 105"** and the
  resolved total becomes **571**. F8 measures against those and reports if its own count disagrees — the
  reconciliation is not permitted to adopt whichever reading makes it pass.

  **Not a discrepancy, and not to be „fixed":** „извън ТР" is 4 in §10 and 3 in §3/§11 because the units
  differ — 3 ЕИК that are not in the register, carrying 4 links between them. §10's row counts links.

  The numbers must also be re-measured on top of the §12 phantom-row fix, which changed the corpus — that
  fix has landed as #281 (87 phantom rows across 15 sets; 256,286 announced − 87 = 256,199, covered exactly
  by 255,582 fetched + 617 missing at source).
- **Every anti-false-zero control is a positive control.** „Sofia seat confirmations: 0" is indistinguishable
  from a broken normalizer without one; so is a joint-stock bar with no marginal effect over
  `closelyHeldForm`, and a matcher that always returns false (ADR-0027's lesson).
- **A partial cache must fail closed.** A missing *or* incomplete registry cache makes the loader throw. An
  80%-restored cache would otherwise yield roughly 80 published links — above the ship floor of 50 — and so
  would ship a decimated surface and wipe the rest from production. The ship floor rises accordingly and is
  passed explicitly rather than defaulted.
- **Crawl hygiene.** „Outside the register" is permanent only from a documented positive response; 429,
  5xx and timeouts are transient and are never cached as a negative. A 429 stops the run rather than
  marking anything, and is never retried — „5 retries with growing backoff" and „429 stops the run" are
  consistent only if retries exclude 429. Given Context 4, the crawl is sequential, paced, resumable, and
  ends the run on the first 429 rather than backing off into it. **The deed's returned UIC must equal the
  requested ЕИК**, or the deed is refused: an ЕИК is TEXT everywhere because public bodies' identifiers are
  exactly the `000…` shape that loses its leading zeros to a numeric round-trip, and the failure mode of
  losing them is fetching, and then publishing against, a different company's deed.
- **The methodology page carries the rule verbatim** (ADR-0021 E10): the ladder, the ≥3-token requirement,
  the entity-boundary rule, the disclosure that identity rests on a name match **without ЕГН**, the homonym
  and seat caveats, the lookup date, the refresh cadence and the retention. E10's existing promise that
  held links „се показват едва след като регистърът стане достъпен" is finally kept by this change.
- **The PII rails are asserted, not assumed** — over the shipped dump and over the loader's own output.

## Consequences

- The surface roughly triples, and 264 links that are withheld today become named public claims. The
  failure mode of the whole change is a **wrong-company** attribution, not a wrong publication decision.
- `tr-census.mjs` and the open-data census pipeline of ADR-0015 are removed. Its premise — that a name
  proven nationally unique identifies the company — is the premise this ADR abandons.
- The pipeline gains a hard dependency on an external registry. Every path that lacked one before now has a
  fail-closed branch: no cache, partial cache, unknown legal form, rate limit.
- We accept a slower, more fragile refresh in exchange for evidence. Decisions stay a pure, zero-network
  function of declarations, cached deeds and contracts, but they no longer run on the 6-hourly ETL cycle
  (#279 §9 assumes they do; they do not — the loader needs `node:sqlite`, the declaration corpus and the
  full winner set, none of which exist inside a Worker). Cadence becomes two scheduled workflows: decisions
  daily, registry lookups monthly. **Superseded by [ADR-0034](0034-registry-lookups-and-decisions-share-one-monthly-run.md):**
  the split rests on the decision run being able to work from the cache alone, and it cannot — the strongest
  rung compares the declarant's name against the deed text itself, which the index deliberately does not
  store, so the raw deeds must be present; and they must not survive the runner. One monthly job, therefore.
  Nothing else in this ADR is affected.
- Two capabilities are deliberately left on the table and become separate changes under new rules versions:
  as-of evidence via `?entryDate=`, and the §7 „и към днешна дата" labels with their post-period contracts.
- The seat rung is structurally capped and we accept the cap: a declared seat is captured **only** from the
  ООД/ЕООД holdings table of an *asset* declaration (`parse.mjs`), so it can never rescue a link declared
  solely in an interests declaration. This is probably consistent with the 102 measured for the seat leg
  specifically (not the 105 of the whole rung, whose other three come from the ЕИК leg) — rung 1 bars the
  joint-stock cases anyway — but it is confirmed against the corpus before launch, not assumed.

### Measured outcome — recorded on completion

This ADR is accepted on the design. Exactly one amendment is permitted afterwards: this subsection is
filled in with the measured result, and nothing else in the file is rewritten (repo convention — an
accepted ADR is superseded, not edited). To be recorded:

- the realized ladder split against the #279 §10 control row **as corrected above** (281 / 105 / 156 / 21 /
  4 / 4 = 571), with each number naming the SQL that produced it, and the gap between identified (281 + 105)
  and surfaced (329) attributed bucket by bucket — 57 links on the corrected reading, 54 on the row as
  written, so the figure itself distinguishes the two;
- the true candidate-ЕИК count (#279's „~400" is an assumption; the figure is `COUNT(DISTINCT eik)` over
  all links, not just published ones);
- the hand-labelled sample result;
- the marginal effect of the registry joint-stock bar over `closelyHeldForm`, and the count of unknown
  `legalForm` codes encountered.
