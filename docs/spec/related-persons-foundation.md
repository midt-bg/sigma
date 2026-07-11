# Спецификация: „Свързани лица" — data foundation (declared interests + ownership)

- **Status:** draft v2 — revised after 3 independent critical passes (data-eng, architecture, legal/external research)
- **Created:** 2026-07-03
- **Owner:** lb
- **Delivers (confirmed):** a **conflict-of-interest** foundation — officials' *declared* company stakes vs public contracts.
- **Contingently unblocks:** #128 checkbox 1 (споделени собственици) and #60, **only if** the unproven TR source (§3.3) clears Phase-0.
- **Continues:** #34 (closed) — but the *external-observer subset* of it, not the full vision (see §1).
- **Depends on:** the ETL pipeline + integrity gate; and **hard-blocks on #173** for any public natural-person output (§8).
- **Publish bar:** **certainty (1.0)** — auto-published for **deterministic exact-name matches** (BG trade names are nationally unique, so declared full-name → our paired `name↔ЕИК` → one entity); only the ambiguous tail is human-reviewed (§5). Order: **Phase 0 (feasibility) first.**

## 1. Why this exists — and what it honestly is

Sigma models **one leg** of public money: spending (`authorities → contracts → bidders`, keyed by ЕИК). It is blind to who is behind a bidder and whether they connect to the officials who direct the spend.

**What this foundation confirmedly delivers:** the **conflict-of-interest** join — an official who *declares* a company stake, where that company won public contracts (§5 metric). The data for this (CACBG declarations) is confirmed and lawful to use (§3.1, §8).

**What it does NOT deliver on its own:** #60 and #128's shared-owner checkbox are about **bidder ↔ bidder** hidden ownership ("скрито свързани изпълнители" / "споделени собственици между изпълнители"). CACBG only exposes **official ↔ company** links — it says nothing about two *bidders* sharing an owner unless an official owns both. Bidder↔bidder ownership requires TR ownership of **both** bidders (§3.3), which is **unconfirmed** and which the codebase itself defers (`source-link.ts:6`). So this spec does not "unblock #60/#128" — it delivers conflict-of-interest today and *may* unblock one #128 checkbox if §3.3 succeeds.

**Honesty vs #34.** #34 argued only the **state** can fully do this — mandate owner disclosure, publish all offers, link by ЕИК; "външен наблюдател не може." We are an external observer on partial public data. This foundation delivers the **external-observer subset**: declared conflicts + bounded public ownership. It is a **lead generator over declared/derivable facts**, a floor — not a claim to have found all hidden ownership. The genuinely corrupt do not self-declare; nominee ownership stays invisible. State this on the methodology page.

## 2. Scope

### Confirmed, buildable now (the MVP)
- **CACBG conflict-of-interest foundation** — ingest declarations → officials' declared company stakes → resolve to bidder ЕИК → surface stakes in contract-winning companies. Self-contained; no external dependency beyond CACBG.

### Contingent (ships only if Phase-0 discovery + Phase-2 match rate pass)
- **Bidder↔bidder shared ownership** (#60, #128 #1) — needs TR ownership of both bidders (§3.3, unconfirmed).
- **Donor→bidder links** (party financing) — needs ЕРИК parse + name matching (§3.2).

### Standalone (ships regardless of the matcher outcome)
- **#60's consortium-only graph** — who co-formed обединения, a *fact* from existing data, labelled „съучастие, не собственост". Needs **no** name-matching, so it is decoupled from the §5 matcher and must not die with it.

### Independent of this foundation (buildable from existing data; noted, not owned here)
- Geographic market-splitting; weak **winner-only** rotation — computable from `contracts`+`bidders`+regions without this spec.

### Out of scope (blocked, documented — not forgotten)
- **Co-bidding, cover bidding, true winner-rotation** — need per-bidder offer lines. No public source (`0000_init.sql:106` — "intentionally NO `bids` table"). OCR of комисия protocols is a separate later spike.
- **Регистър на действителните собственици** (ЗМИП/AML BO) — parked. Post-CJEU (C-37/20, 2022) and a **June 2025** Bulgarian move to a "legitimate-interest" access model put the regime in flux; do **not** un-park without a fresh legal check.

### Honest #128 accounting
Of #128's five checkboxes: **1** (shared owners) contingently unblocked via §3.3; **2 & 5** (co-/cover-bidding) permanently blocked on non-public offer data; **3 & 4** (rotation, geo) independent of this spec.

## 3. Data sources

### 3.1 CACBG declarations — CONFIRMED (inspected + legally verified 2026-07-03)

**Legal identity:** register operated by the **Сметна палата, дирекция „Публичен регистър"**; declarations filed/published **под чл. 75 ЗСП** (chain: ЗПКОНПИ repealed → ЗПК in force 6 Oct 2023 → ЗИД ЗСП transferred ЛЗВПД declaration publication to the Court of Audit). Publication is a **statutory obligation** → declared facts are public-by-law and republishable. No open-data licence and no explicit reuse restriction. Methodology page cites **ЗСП чл. 75**, not ЗПКОНПИ.

**Structure** (`register.cacbg.bg/<year>/`, JS-driven over static data):
- `index.html` shell + `../core2.js` (loads `<year>/list.xml`; `/core.php` serves search).
- **`list.xml`** (2025 ≈ 4.8 MB): `root → MainCategory → Category[Name] → Institution[Name] → Person[Name] → Position[Name] → Declaration{Sent, xmlFile}`. **15,925 persons / 34,862 declarations for 2025.** High-signal categories incl. **„Лицата, упълномощени по реда на ЗОП … да сключват договорите"** — procurement signatories.
- Each `xmlFile` is an **individual declaration XML** (≈ 45 KB, `Table/Row/Cell`, ~21 tables). Metadata: `Name`, `Position`, `Address`, `Spouse`, `Children`, `Year`, `DeclarationType`, `ControlHash`. **`EGN` present as a tag but stripped (empty).** **No birthdate.**
- **Company holdings** as rows (confirmed real row): `дружествени дялове | 100% | "ДЕМИР АГРО" ЕООД | Шумен | 100 | <holder> | възмездно` — `type, stake%, company name+form, town, value, holder, mode`. **No ЕИК on companies.**
- **Folder-year vs declared-year offset:** register folder `N` holds declarations whose `Year` field is `N−1` (`/2025/` → `Year=2024`). Temporal joins use `Year`, not the folder.

**Ingestion window:** match the contract data (2020–2026) → register folders `2020`…`2026` (declared years ≈ 2019–2025), whichever exist.

**Do NOT store-for-publish:** `Address` (КЗЛД strips addresses on publication); `EGN` even if ever present; family names except behind masking (§8).

**Ingest = acknowledged NEW infra** (see §7): a **resumable crawler** over ~240k XML files (≈35k/yr × up to 7 yrs) at a polite rate, into a **persistent raw-XML cache keyed on `xml_file` + `ControlHash`** (natural key for idempotency and change detection), decoupled from `normalize`. Host-scoped explicit TLS handling (broken cert chain), never a global bypass.

### 3.2 Party financing — source RESOLVED (ЕРИК); parse shape = Phase-0

**Source:** **ЕРИК — Единен регистър по Изборния кодекс** (`erik.bulnao.government.bg`, Court of Audit), free/public; plus per-party public donor registers (чл. 29, ал. 2 ЗПП). Publishes donor names, donation type/amount/value, origin declarations.
**Caveats to resolve in Phase-0:** (a) **donor ЕИК likely NOT a published field** → donor→bidder resolution falls back to the §5 name+town matcher; (b) likely **HTML-only, no bulk export**; (c) **election-scoped retention** ("до следващите избори") → older cycles in the 2020–2026 window may need archived/Wayback snapshots.

### 3.3 Targeted TR owners — access CONFIRMED public; endpoint/limits = Phase-0

**Per-ЕИК public lookup** (`portal.registryagency.bg`) is free, no fee. Recoverable per ЕИК: **управители, съдружници/собственици на капитала + stakes, капитал, legal form, seat.** **ЕГН masked** → owner identity name-based. Run **only** for the bounded set (bidders + resolved declared/donor companies) — thousands, not ~900k.
**Hard constraints (DPA-verified):** **NEVER bulk-scrape TR** (КЗЛД ruled bulk provision unlawful; CJEU C-200/23 climate). **Never store scraped ЕГН**, even if leaked in a document image. Phase-0 confirms endpoint, fields, and rate limits.

## 4. Data model

New domain tables, built by `normalize-raw.sql` from persistent staging; `interest_links` written by a **JS resolver pass** (§5), NOT by fuzzy SQL.

| Table | Grain | Source | Notes |
|---|---|---|---|
| `persons` | one person **per declaration** | all | id anchored on `(register_year, institution, position, name_normalized)` — **never a bare name key**. **No `birth_year`** (not in data). Cross-institution/cross-year linking is a *review-gated* corroboration step, never automatic. |
| `declarations` | one CACBG declaration | CACBG | `person_id`, `year`, `position`, `institution`, `category`, `xml_file`, `control_hash`, `source_url`, `sent`. Address NOT stored-for-publish. |
| `declared_interests` | one holding row | CACBG | `kind`, `stake_pct`, `company_name_raw`, `company_town`, `value`, `holder_relation` (self/spouse/child), `acquisition_mode`, `acquired_hint` |
| `party_donations` | one donation | ЕРИК | `donor_name`, `donor_kind`, `donor_eik` (**nullable, usually NULL**), `party_name`, `amount`, `date`, `source_url` |
| `company_owners` | one owner/manager record | TR targeted | `company_eik`, `person_name`, `role`, `stake_pct?`, `source_url`, `fetched_at`. No ЕГН stored. |
| `interest_links` | one candidate/verified edge | JS resolver + human review | `subject_person_id`, `company_eik`, `bidder_id`, `contract_id?`, `authority_id?`, `link_kind`, `match_method`, `confidence`, `provenance`, `matcher_version`, `first_asserted_at`, `superseded_at`, **`status`** (candidate/verified/rejected), **`verified_by`, `verified_at`**. Only `status='verified'` is public (certainty bar, §5). |
| `link_suppressions` | one correction/takedown | appeals | survives re-import (§8); a suppressed `(subject, company, source_row)` is never re-asserted. |

**Person identity** has no ЕГН and no birthdate → it is the **weakest** join, not a safe one. The `list.xml` hierarchy binds Person→Position→Institution within a register-year; use that. Homonyms (Георги Иванов) are pervasive → a bare name key would silently merge two distinct officials (false-accusation vector). Therefore per-declaration nodes + cautious, corroborated, review-gated cross-linking only.

## 5. Matching layer (the crux) — a JS resolver pass

**The resolution is deterministic — two verified facts make it so:**
1. Our own bidder data pairs **`contractor_name ↔ contractor_eik`** in the *same* ЦАИС ЕОП source record (`raw_contracts`) — so for every company that won public money we already hold name→ЕИК. **No external registry is needed to resolve the ЕИК.** (TR is needed only for *owners* — leg 2, §3.3 — not for this join.)
2. **BG trade names are nationally unique by law** (ЗТРРЮЛНЦ чл. 21 т. 7 preventive control; ТЗ чл. 7) — an exact registered фирма (**including legal form**) identifies exactly one entity → one ЕИК.

So: normalize the declared full name (incl. legal form) → **exact-key match** against `bidders.name` → the paired `eik_normalized` is the company's ЕИК, **deterministically** → automatic ЕИК-join to contracts → **auto-publish, no human**. Town is *not* needed for identity (uniqueness is national), so the sparse `settlement` is **not a blocker** — it's only a secondary corroborator for edge cases.

**Placement:** a **JS resolver pass** (D1 has only FTS5+BM25; rank ≠ confidence). FTS generates candidates; **exact normalized-key equality decides the deterministic match**; `precompute` only rolls up.

**The one real risk is normalization, not ambiguity.** The declared string and the ЕОП `contractor_name` are entered independently, so "exact match" means exact **after conservative normalization** (case/whitespace/quote/diacritic folding, Cyrillic canonicalization). Normalization **must NOT drop legally-distinguishing tokens** (legal form, ordinals) — national uniqueness guarantees identity only for the *full* фирма, so erasing the form could wrongly merge „АЛФА" ЕООД with „АЛФА" АД (distinct ЕИК). A conservative normalizer that preserves distinguishing tokens makes an exact-key match **= same entity = deterministic**. This is the sole libel surface, and it is **empirically measurable** — Phase 0 runs the normalizer on a labelled sample and measures any over-merge; **the bar is 0 false merges.**

**Auto-published (deterministic, no human):** declared full name normalizes to a key matching **exactly one** `eik_valid=1` bidder. This is the majority path.

**Phase-0 empirical result (measured 2026-07-04, full 2020–2026 corpus):** ran the real pipeline — 73,603 declarations (2017–2025, 99% of fetchable) → 7,744 declared self-holdings → matched against 17,669 contract-winners.
- **Libel gate PASSED: 0 true normalizer over-merges** (distinct name *strings* folded to one key) on the real winner corpus — the normalizer only ever folds presentation (case/space/quotes).
- **Headline: 100 officials hold a declared stake in 104 companies that won public contracts** (160 holding-rows incl. annual re-filings). Worked example: a deputy regional governor of Русе declaring „Полис инженеринг" ЕООД, which won from Община Русе.
- **Correction to the uniqueness assumption (point 2 above is not absolute):** 53 winner keys map to >1 real ЕИК. Cause is *never* the normalizer — it is (a) genuinely **shared generic names** (regional „Водоснабдяване и канализация" ЕООД, „В и К" ООД — municipal monopolies registered per-region, not nationally unique on the bare name) and (b) **source ЕИК typos** (one-digit-off ЕИК for the same фирма). So the deterministic rule is **single-key AND single-winner-ЕИК** (not single-key alone); this quarantined all 53 — **0 leaked into the auto bucket** in this corpus.
- **Residual risk → a Phase-1 requirement:** a *generic* name with exactly one winner namesake passes the single-ЕИК guard yet may not be globally unique in TR. Before auto-publishing generic-named matches, add a **TR-wide name-uniqueness census** (or a leg-2 per-ЕИК confirmation); distinctive names auto-publish, generic names route to the census/human tail.

**Human tail (the small residue only):**
- declared name **truncated / missing legal form** → could map to >1 фирма → ambiguous;
- normalized key matches **>1** bidder (should be ~0 under uniqueness; if seen, a normalization/data defect to fix);
- **temporal name-reuse** (a dissolved фирма re-registered under a new ЕИК) → flagged by the temporal check;
- **name-keyed / consortium** bidders (NULL ЕИК) → no ЕИК to bind → always review.
These carry `status` + (when resolved) `verified_by`/`verified_at`. Volume is bounded — only companies appearing in *both* a declaration/donation *and* the winner set are in scope.

**Provenance (every candidate + link):** `source_url`, raw declared strings, matched `bidder_id`, `match_method`, `confidence`, `matcher_version`, and (once verified) `verified_by`/`verified_at`. UI shows the full receipt chain inline.

**Known recall holes (enumerate on methodology page):** build the name→ЕИК index from the **full `bidders` table** (every winner), **not** `company_totals` — the latter drops FX-rateless (`amount_eur` NULL) bidders and would silently make them unmatchable. Genuine remaining holes (all safe false-negatives): a company that **won under a since-changed name**, and ownership held via a **HoldCo** (an owners/leg-2 concern, not this name join). Stated up front.

**Headline metric:** count of ЛЗВПД holding a *declared* stake in a company that won public contracts (**deterministic exact-name matches**; the ambiguous tail is excluded or human-confirmed, never guessed), and the subset winning **from the official's own institution** with temporal overlap (§ below). A defensible floor, framed as declared leads — never "all conflicts."

**Temporal logic:** a declaration is a **point-in-time snapshot**, not an interval. A stake acquired late-year vs a contract won early-year is a **false overlap**; a stake sold mid-year still shows in the prior declaration; entrants/leavers file nothing for years out of office. Use `Year` with an **uncertainty band** + `acquisition_mode/acquired_hint` to bound the holding start. **Verify the ЗОП-signatory category's filing cadence** (annual vs event-triggered) before relying on annual re-filing.

## 6. Phases and proof-gates (numeric, falsifiable)

### Phase 0 — Feasibility spike (kill-criteria; do this before committing to the build)
- **Normalizer — 0 over-merge (the core proof):** build the conservative name normalizer (case/whitespace/quote/diacritic/Cyrillic folding, **preserving legal form + distinguishing tokens**); hand-label a stratified sample (true pairs + hard negatives: same-core/diff-form, near-duplicate names, name-keyed bidders); measure **over-merge (two distinct фирми → one key). Bar = 0.** This is the libel-safety proof.
- **Auto-match rate:** over the declared∩winner scope, what fraction of declared companies produce a **single exact-key** `eik_valid=1` bidder match (the deterministic auto-publish rate) vs the ambiguous tail. This number tells us how automatic the pipeline is.
- **Human-tail size:** count the ambiguous residue (truncated names, >1 match, name-keyed bidders). Decide the tail policy with lb (review vs auto-drop).
- **ЕРИК:** confirm parse shape, donor-ЕИК presence, retention/Wayback for 2020–2026.
- **TR (leg-2 only):** confirm per-ЕИК owner-lookup endpoint/fields/limits — needed for *owners*, not for the core resolution.
- **Cadence:** verify ЗОП-category filing cadence for the temporal model.
- **Gate:** normalizer over-merge = **0** on the labelled sample; auto-match rate measured; ambiguous tail has a decided policy. If the normalizer cannot hit 0 over-merge, that is the **no-go** — surface it, don't paper over it. (Settlement is *not* a blocker — national name-uniqueness means town isn't needed for identity.)

### Phase 1 — CACBG ingestion (the confirmed MVP; independent of Phase 0's TR/ЕРИК)
Resumable crawler + raw-XML cache (`control_hash` key) → parser → `persons/declarations/declared_interests`.
- **Gate:** ≥ (stated N, e.g. all 2020–2026 folders, ≥95% of `Sent=True` declarations parsed) ingested; **idempotent** re-import (re-run yields zero drift; natural key = `xml_file`+`control_hash`); staging survives the full `normalize` rebuild; adversarial parser tests (malformed XML, empty holdings, missing town, TLS quirk).

### Phase 2 — Deterministic resolver + ambiguous-tail handling (the go/no-go)
JS resolver → deterministic exact-key matches (auto-published) + ambiguous tail (per Phase-0 policy).
- **Publish rule = certainty (1.0):** auto-publish **only** exact-key single-`eik_valid=1` matches, which BG national name-uniqueness guarantees are the same entity (§5). The ambiguous tail never auto-publishes.
- **Gate:** the normalizer holds **0 over-merge** on a held-out labelled set (re-proven, not just Phase-0); the deterministic resolver is idempotent + fully tested (adversarial: form-only-difference pairs, near-duplicates, name-keyed bidders, temporal reuse); the ambiguous tail is handled per the decided policy; a **verified** headline count with worked, fully-sourced examples. If over-merge > 0 on held-out data, stop before public UI.

### Phase 3 — Integration (hard-gated on privacy)
- **HARD BLOCKER:** **#173 must land first** — natural-person masking proven on `.json`/`.csv` **and the `.data` twin** (#184's rate-limit fix is merged, but that closed the *limiter* bypass, not the *mask*; the `.data` surface must be re-verified against the masking policy, per the .data under-protection pattern). **Family-relation rows (`holder_relation ≠ self`) stay INTERNAL-only for v1** — the §5 metric is the official's own holdings; do not publish third-party data over surfaces known to leak.
- Fill `ConsortiumParticipant.eik`/`resolvedSlug` (#60); extend `NetworkNode.kind` to `'person'`; add a „Декларирани връзки" panel; feed #128's shared-owner heuristic **iff** §3.3 delivered.
- Build against **`main` after** the in-flight graph work (#140/#144) merges — do **not** cherry-pick unmerged stacked branches (merge-order hazard).
- **#60 consortium-only graph may ship earlier**, independent of all of the above.
- **Gate:** consumed correctly on the fork's ephemeral deploy; masking holds on every output format.

## 7. Architecture fit — honest about what's new

Domain tables + rollups ride the existing pipeline (`normalize-raw.sql` → `precompute.sql` → `ship-domain` → **`assertIntegrity`**). **New infrastructure this genuinely adds** (the "no new infra" claim was wrong): a **resumable, rate-limited, cached crawler** over three external gov registers (one broken-TLS, one rate-limited, one HTML-only); a **JS resolver pass**; a **suppression/correction store** surviving re-import; and **source-schema-drift monitoring** (the integrity gate covers re-import drift, not upstream schema/availability drift across 2020–2026 × annual).

**Refresh = scheduled Cron Worker (not a manual re-run).** The crawler runs as a Cloudflare **Cron-triggered Worker** (fan-out via **Queue**), same operational model as the EOP ingest. Closed years (frozen at source) live permanently in **R2** and are never re-fetched; the trigger only pulls the **current-year delta** — new `xml_file`s and any resubmission whose `control_hash` changed — via the `done`/ETag skip set, so a refresh is a few hundred fetches, not the ~280k full corpus. Cadence per §6.167 (withdrawn/amended declarations + officials leaving office must expire stale `interest_link`s, else a stale link implies a *current* conflict that has ended = live accuracy defect).

**Timeouts — where they live.** The long-run risk is *designed out*, not configured: the cold backfill (~280k fetches, one-time) never runs inside a timed job; the refresh Cron Worker only enqueues, and Queue consumers process bounded batches, each inside Worker CPU limits, retrying failures. So there is **no** timeout to set in the GitHub Actions CI `.yaml` — the crawl doesn't execute there. Three timeout controls that *do* apply, in descending relevance: (1) a **per-request socket timeout in the crawler itself** (`getPinned`, 30 s → retry/backoff) — the only one that exists today and matters even locally, since a hung connection to the slow source would otherwise stall a slot forever; (2) **Queue consumer settings** (`max_batch_size`, `max_retries`, `max_batch_timeout`) and (3) **`limits.cpu_ms`** — both in **wrangler** config (`.jsonc`/`.toml`), authored when the deploy layer is built, not in CI yaml. Folder discovery reads the register index each run, so new folders (next year's set, new compliance sets) are picked up automatically.

**Workspace:** isolated fork worktree off synced `main`; verify on the fork's ephemeral env; product lands upstream via PR per proven phase.

## 8. Guardrails (non-negotiable — DPA-verified)

**Legal / personal-data (КЗЛД- and CJEU-grounded):**
- **Officials' declared facts** — lawful to republish with a source link (ЗСП publication obligation + GDPR 6(1)(c)/(f) + Art. 85 expression margin). Green-light.
- **Third-party (spouse/child) data** — КЗЛД: publishable only to the extent the law explicitly provides; the declarant's consent does **not** extend to third persons; otherwise **anonymize**. → family-relation rows **internal-only for v1**; if ever surfaced, masked on **every** format, hard-gated on #173 (incl. the `.data` twin).
- **Strip on publication:** address, ЕГН, ID-doc/bank numbers (КЗЛД list) — never store-for-publish.
- **Storage-limitation:** no statutory online-retention window → indefinite republication conflicts with the DPA principle. Add a **retention/refresh statement** to the methodology page.
- **DPIA / lawful-basis note** before any natural-person *aggregation* into a searchable index — apply the BO-register (CJEU C-37/20) "public-by-law ≠ unlimited re-publication" reasoning **symmetrically** to CACBG family/asset data, not only to the parked BO register.
- **TR:** bounded per-ЕИК only, never bulk (DPA-hostile), never store ЕГН.

**Accuracy (project rule — accuracy blocks merge):**
- **Certainty bar (1.0):** auto-publish **only** deterministic exact-name matches (BG national name-uniqueness → same entity); the ambiguous tail never auto-publishes. The libel surface is the **normalizer**, proven to **0 over-merge** on a labelled set with hard negatives (form-only-difference pairs, near-duplicates). Resolver + tail workflow get adversarial self-tests.
- Present links as „модел за проверка, не обвинение" (#34); the tool shows declared/derivable links, never claims completeness.

**Corrections & lifecycle (defamation-sensitive):**
- **Appeal/correction/takedown workflow** with an intake contact and a resolution SLA — designed, not just named. Corrections land in `link_suppressions` and **survive re-import** (idempotency must not re-assert a removed link).
- **Refresh cadence + source reconciliation:** re-scrape on a stated cadence; handle **withdrawn/amended** declarations and officials leaving office — a stale `interest_link` implies a *current* conflict that has ended (= accuracy defect on live prod).

## 9. Public methodology page (clear and explicit — a hard requirement)

The public site MUST carry a plain-language methodology page. It is part of the libel defence: a reader must see exactly how a link was made and be able to re-derive it. It states, explicitly:
1. **Sources + legal basis** — CACBG declarations (ЗСП чл. 75, Сметна палата); ЕРИК (Изборен кодекс); targeted TR per-ЕИК (public company facts). Each with a direct source link.
2. **What is shown and what is not** — officials' own declared holdings; **family holdings are NOT published** (v1); addresses/ЕГН never shown.
3. **The matching rule, verbatim** — declared company **full name** (incl. legal form) is normalized and matched **exactly** against the winner's registered name, which is paired 1:1 with its ЕИК in the procurement source; because Bulgarian trade names are **nationally unique** (ЗТРРЮЛНЦ/ТЗ), an exact match is the same legal entity. Ambiguous cases (truncated names, no exact match) are **excluded or human-confirmed, never guessed**. Every link shows its full evidence chain.
4. **Certainty & framing** — only deterministic exact matches (and human-confirmed cases) appear; each is a „**модел за проверка, не обвинение**"; the tool shows *declared* links only and **does not claim to find hidden ownership** (it is a floor, not the full picture).
5. **Temporal meaning** — a declaration is a point-in-time snapshot; how overlap with a contract date is (and isn't) interpreted.
6. **Known gaps** — the recall holes (§5), self-reporting limits, sources it cannot see.
7. **Corrections & appeal** — how to contest a link, the contact, the SLA, and that a corrected link stays removed across refreshes (§8).
8. **Retention & freshness** — refresh cadence; how withdrawn/amended declarations are handled.

## 10. Open questions / risks (ranked)

1. **Normalizer over-merge (0-bar) + auto-match rate — THE go/no-go.** The deterministic join rests entirely on a conservative normalizer that **never merges two distinct фирми** (the sole libel surface; bar = 0, Phase-0 measured) and on how many declared companies exact-match a winner (the auto rate). Not "can the algorithm be precise" but "does the normalizer prove 0 over-merge, and is the ambiguous tail small." Resolved in Phase 0/2.
2. **Family-data masking** — highest *legal* risk; only mitigated if #173 masking is proven on every format incl. `.data`. v1 keeps family rows internal.
3. **Settlement backfill** — the town gate is inert pre-2026 until this is solved (Phase 0).
4. **ЕРИК format/retention** — HTML-only, no donor ЕИК, election-scoped retention may drop older cycles → may shrink §3.2.
5. **Person disambiguation without ЕГН** — conservative per-declaration nodes; cross-year identity may be unneeded for the headline; homonym merge is the failure to avoid.
6. **CACBG storage-limitation** — add retention line (§8); low viability threat, real compliance gap.
7. **BO register regime in flux** (June 2025 legitimate-interest) — stays parked; risk is scope-creep by treating BO as "still public."
