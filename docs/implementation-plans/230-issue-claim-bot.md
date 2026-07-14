# Implementation Plan: #230 — Issue-claiming bot (`/assign`) against duplicated work

## Executive Summary

| Field | Value |
|---|---|
| Ticket | [midt-bg/sigma#230](https://github.com/midt-bg/sigma/issues/230) (+ expanded English proposal provided alongside it — same design) |
| Goal | Let drive-by contributors *claim* an issue via a `/assign` comment so two people don't start the same work — without granting repo access. Auto-release zombie claims. |
| Approach | Two thin GitHub Actions workflows + **one tested `scripts/issue-claim.mjs` module** holding all decision logic |
| Complexity | Medium (logic is small; the traps are security + testability, not volume) |
| Time Estimate | ~1 day (0.5d module + tests, 0.25d workflows, 0.25d owner steps + docs) |
| Risk Level | Medium — runs with `issues: write` on **untrusted comment input**; the issue's inline draft has exploitable defects (below) that this plan fixes |
| Status | **Draft — awaiting maintainer decision.** #230 is labeled `status: needs-decision`; the model itself is not yet approved. This plan is the "if approved, build it this way" blueprint and also touches `.github/` (coordinate with @cefothe per the issue). |

> **Decision gate first.** Do not open the implementation PR until the model is accepted on #230 and the `.github/` overlap with the CI/branch-protection thread is cleared with @cefothe. This plan assumes acceptance.

---

## 🚨 Critical Implementation Standards

From the global CLAUDE.md + repo `AGENTS.md`/`CONTRIBUTING.md`, non-negotiable for this change:

- **`tests-with-code`** — logic ships with `node --test` unit tests. The issue's inline-YAML JS is untestable; **this is the single biggest deviation the plan corrects.**
- **`error-handling`** — every parse/API path guarded. The draft's unguarded `JSON.parse` is a live DoS (Finding S2).
- **Pin actions to SHA** — repo pins every third-party action with a version comment. The draft's `actions/github-script@v7` (floating tag) must become the in-repo-vetted `@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0`.
- **Least privilege** — per-job `permissions:`; **do not** flip the repo default to "Read and write" (the issue's owner-step #2 over-privileges every other workflow — see Finding S6).
- **User-facing text in Bulgarian** — `CONTRIBUTING.md` mandates it. The draft's bot replies are English (Decision D3).
- **No secrets, no scope creep** — `.github/` only + one `scripts/` module + one `CONTRIBUTING.md` line.

---

## Current State Analysis

### What exists (verified)

| Path | Relevance |
|---|---|
| `.github/workflows/preview-reap.yml` | **Direct precedent.** Scheduled job, `<!-- sigma-preview -->` body-marker, `github-script@…v9.0.0` SHA-pinned, `timeout-minutes: 10`, `concurrency`, least-priv `permissions`. Mirror this shape. |
| `.github/workflows/scripts-test.yml` | Runs `node --test scripts/*.test.mjs`. A new `scripts/issue-claim.test.mjs` is **auto-picked-up with zero workflow changes** — the intended extension point. |
| `scripts/reap-previews.mjs` + `.test.mjs` | **The extraction pattern to copy:** exported pure functions (`selectStale`, `reapStale`) + injected I/O (`fetchImpl`, `del`) + `isMain(...)` guard, fixture-driven tests including exact boundary cases. |
| `scripts/check-docs.mjs` | Canonical `isMain(import.meta.url, process.argv[1])` guard; pure-vs-fs separation. |
| Labels (`gh label list`) | `status: needs-triage/needs-decision/blocked`, `good first issue`, `help wanted` exist. **`status: in-progress` does NOT — must be created.** |
| `CONTRIBUTING.md` | Bulgarian, forks+PR flow. Add one Bulgarian line about `/assign`. |
| `.github/ISSUE_TEMPLATE/` | `config.yml`, bug/data/feature templates. Optional hint line. |

### Gap vs. the issue draft

The issue ships **complete inline JS inside both YAML files**. That surface pattern (markers, github-script) is right and consistent with `preview-reap.yml`, but it:
1. Cannot be unit-tested (violates `tests-with-code`).
2. Duplicates `MARKER`/`BANNER`/label constants across both files → drift bug.
3. Uses a floating action tag.
4. Carries three exploitable defects (below).

---

## Target Architecture

```
.github/workflows/assign-issue.yml            (thin: issue_comment → env → node → octokit writes)
.github/workflows/stale-assignment-check.yml  (thin: schedule → node → octokit writes)
                       │
                       └── imports ──▶ scripts/issue-claim.mjs   (ALL decision logic, pure)
                                       scripts/issue-claim.test.mjs (node:test, ~50 cases)
```

**Principle (from `reap-previews.mjs`):** functions never receive an octokit client — they receive *already-fetched plain data* and return decisions. Workflows are I/O glue: fetch → call pure fn → write result. This is exactly the `preview-reap.yml` boundary.

### `scripts/issue-claim.mjs` — exported pure functions

| Function | Signature (in → out) | Replaces draft logic |
|---|---|---|
| `parseCommand(body)` | comment string → `'/assign' \| '/unassign' \| null` | the `startsWith` gate + exact-word guard |
| `parseClaimMarker(body)` | issue body → `{ user } \| null`, **never throws**, validates `user` matches `/^[A-Za-z0-9-]{1,39}$/` | `JSON.parse(m[1])` |
| `writeClaim(body, user)` | → body with banner+marker prepended to a **stripped** base | `writeClaim` |
| `stripClaim(body)` | → body with **all** markers+banners removed (global regex) | `stripClaim` |
| `canUnassign({actor, claimedUser, authorAssociation})` | → boolean | the privilege branch |
| `computeIdleDays({timeline, createdAt, nowMs})` | → number, last **human** event, bot events excluded | the `lastHuman` reduction |
| `hasOpenLinkedPr(timeline)` | → boolean; reads state off the event, null-safe on `source`/`issue`/`repository`; fork-source aware (O3) | the `cross-referenced` check |
| `shouldNudge({idleDays, nudgeDays, timeline, nudgeMarker})` | → boolean, idempotent; detects prior nudge by the **`<!-- sigma-nudge -->` marker** only, not free-text (O1) | the `nudged` guard |

Constants (`MARKER`, `BANNER`, `IN_PROGRESS`, `NUDGE_DAYS=14`, `RELEASE_DAYS=21`) live **once** here; both workflows import them → kills the duplication/drift bug.

`isMain(import.meta.url, process.argv[1])` guard so the file is importable by tests but runnable if ever needed directly.

### Marker format (unchanged, consistent with repo)

`<!-- sigma-claim: {"user":"x"} -->` + visible `**🔧 Claimed by:** @x` banner + `status: in-progress` label. Mirrors the existing `<!-- sigma-preview -->` precedent.

### "Two files" vs. the proposal's "three workflows"

The expanded proposal lists **three** workflows, but its own rollout says *"add both workflow files"* — item #3 (**linked-PR awareness**) is a *pre-check inside* the stale sweep (it needs the same timeline fetch to decide skip-vs-nudge), not a separate file. This plan builds **two** workflow files; linked-PR awareness is the `hasOpenLinkedPr(timeline)` guard in `stale-assignment-check.yml`. Splitting it into a third workflow would duplicate the timeline fetch for no benefit. Flag D4 if the maintainer actually intended a distinct file.

### Precedent (from the proposal, load-bearing for the design choice)

The body-marker approach is not novel: **Rust's `@rustbot claim`** hit the identical GitHub non-collaborator restriction and solved it the same way (bot edits the top comment to record the claim); **Kubernetes' Prow** uses `/assign`/`/unassign` chatops. GitHub's **Triage role** is the native alternative (deferred — needs a per-contributor maintainer invite, doesn't fit drive-by volunteers). **`actions/stale`** is the standard tool for the *PR*-staleness companion (open question, out of scope here).

---

## Multi-Agent Review — Findings & Resolutions

Three specialists reviewed the draft against repo conventions. **Consensus: accept the *model*, reject the *inline implementation*; extract + test + harden.**

### 🔒 Security (must-fix before merge)

| ID | Sev | Finding | Fix in this plan |
|---|---|---|---|
| **S1** | HIGH | **Claim/identity spoofing.** An issue author can edit their own body to inject `<!-- sigma-claim: {"user":"maintainer"} -->` + a fake banner. `MARKER.match` (no `/g`) trusts it; the `/unassign` gate then compares against attacker-supplied `claim.user`. | Treat the body as **untrusted**. `parseClaimMarker` validates `user` shape and rejects malformed. The privilege gate uses `context`-derived `actor`/`author_association` (trustworthy), never a body-derived identity for authorization. Consider (D2) storing the claim of record in a **bot-authored comment** rather than the editable body. |
| **S2** | HIGH | **Unguarded `JSON.parse` DoSes the whole daily sweep.** One issue with `<!-- sigma-claim: not-json -->` throws inside the sweep loop → every later claimed issue skipped, permanently. | `parseClaimMarker` wraps parse in try/catch, returns `null`. Sweep `continue`s on `null`. Covered by test 2.3. |
| **S3** | HIGH | **Non-global strip leaves a second marker → sticky claim.** `.replace(MARKER,'')` without `/g` removes only the first; a seeded duplicate survives `/unassign` and auto-release. | `stripClaim` uses global regexes; reject/normalize >1 marker. Tests 3.8/3.9. |
| **S4** | MED | `author_association` gate: `MEMBER` = any public org member, not necessarily write. | Acceptable for a low-stakes "release a claim" (defense-in-depth, self-assertion impossible). Optional hardening (D2): `repos.getCollaboratorPermissionLevel` ≥ `write`. |
| **S5** | MED | `claim.user` flows into comment bodies / `removeAssignees` unvalidated (newline/markdown injection into bot comments). | `parseClaimMarker` validates against `/^[A-Za-z0-9-]{1,39}$/`; non-matching → treated as no claim. |
| **S6** | LOW | **Both** the issue *and* the expanded proposal's rollout step #2 ("Settings → Read and write permissions") over-privilege **every** workflow in the repo. | **Drop it.** Per-job `permissions:` blocks already scope correctly (`preview-reap.yml` proves this works with the repo default read-only). Do not flip the org/repo default. |
| **S7** | LOW | Comment-spam re-triggers; no throttle. | Keep no-op early-returns (already in draft); `concurrency` per issue serializes. Accept residual (GITHUB_TOKEN rate-limited). |

### 🏛 Architecture

- **P0** Extract logic to `scripts/issue-claim.mjs` (above). **P0** SHA-pin `github-script` → `…v9.0.0`; pin `checkout`/`setup-node` (SHAs already in `scripts-test.yml`) now that workflows run node.
- **P1** De-dup constants via the shared module (free once extracted). **P1** Add `timeout-minutes: 5`, `concurrency`, least-priv `permissions` to both jobs.
- **P2** Keep **two** workflow files (different triggers `issue_comment` vs `schedule`) — correct decomposition, mirrors `preview.yml` vs `preview-reap.yml`. Share the *module*, not the workflow.
- **Scale note:** bound the sweep's `listForRepo` pagination (issue-paced volume is fine; add a `MAX_PAGES`-style guard comment like `listWorkerScripts`).

### 🧪 Testing

Full `node:test` matrix accepted as the coverage contract (see Testing Strategy). Critical: `computeIdleDays` bot-vs-human (2 cases pin "bot nudge must not reset the clock"), the malformed-marker no-throw cases, and the anti-spoof strip cases.

### ⚙️ Operational correctness (round-2 review)

A second review pass (security-auditor + deployment-engineer + test-automator, 2026-07-14) reconfirmed S1–S7 and added the following **operational** fixes. All are folded into the phases/tests below.

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **O1** | MED | **Nudge-detection by free-text `/auto-release/` is brittle** — the release comment can contain the same substring, and a re-claimed-then-idle issue then never re-nudges. | Emit an **invisible marker** in each bot comment: `<!-- sigma-nudge -->` in nudges, `<!-- sigma-release -->` in releases. `shouldNudge` matches the nudge marker only — never shared prose. Kills the false-positive. |
| **O2** | MED | **`issues.update` (body) is a read-modify-write with no retry.** `github-script` does not retry 409/422; a colliding edit silently drops the claim while the confirmation still posts. Per-issue `concurrency` serializes the *queue* but not an external concurrent body edit. | Wrap the single `issues.update` in a small 3-try backoff on `status ∈ {409,422}`; re-read the body before each retry. Bounded, no new deps. |
| **O3** | MED | **`hasOpenLinkedPr` assumes the base repo.** A `cross-referenced` event from a **fork** PR carries `source.issue.repository` = the fork; skip-logic that queries `context.repo` misreads fork PRs and can wrongly release a still-active claim. | Read `event.source.issue.state`/`pull_request` directly off the timeline event (already includes state); do **not** re-`pulls.get` against `context.repo`. Null-safe on `source`/`issue`/`repository`. Test 6.x adds a fork-source fixture. |
| **O4** | LOW | **Blanket `try/catch {}` around `removeLabel`/`removeAssignees` hides real failures** — a swallowed `removeLabel` leaves `status: in-progress` set, so the sweep re-processes and re-comments the issue forever. | Catch **by `error.status`**: swallow only the known-benign `404` (label/assignee absent) / `422` (not assignable); `core.warning(...)` anything else instead of silent `{}`. |
| **O5** | LOW | **Bot feedback-loop guarded only by comment prose** (`startsWith('/assign')`). Any future bot message starting with the token re-triggers. | Add an identity guard to the job `if:`: `github.event.comment.user.type != 'Bot'`. Defense-in-depth beside the existing prose gate. |
| **O6** | LOW | **`author_association` is coarse** — `MEMBER` = any public-org member, not necessarily write on *this* repo (also reconfirms S4). | Preferred: `repos.getCollaboratorPermissionLevel(actor) ∈ {admin, write}` for the `/unassign` override. `canUnassign` already takes an injected `privileged` boolean, so the resolver swaps in with **no test churn**. |

`shouldNudge`/`computeIdleDays` signatures gain the nudge-marker string (O1); `canUnassign` keeps its injected `privileged` boolean so O6 is a workflow-glue swap, not a logic change. `hasOpenLinkedPr` reads state off the timeline event (O3).

---

## Implementation Phases

### Phase 0 — Decision & coordination (BLOCKING, no code)
- Confirm #230 model accepted by maintainers (@todorkolev, @nedda76).
- Clear `.github/` overlap with the CI/branch-protection thread with **@cefothe**.
- Confirm Decisions D1–D3 below.

### Phase 1 — Module + tests FIRST (TDD)

**Task 1.0 — Write `scripts/issue-claim.test.mjs` (red).**
Encode the full matrix (Testing Strategy). Fixed reference instant `const NOW = Date.parse('2026-07-14T12:00:00Z')` + `daysAgo(n)` helper — no live `Date.now()` (repo convention; and `Date.now()` is unavailable in some harnesses). `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`.

**Task 1.1 — Implement `scripts/issue-claim.mjs` (green).**
Pure functions above + constants + `isMain` guard. No octokit import. Every parse guarded (`error-handling`). Global strip regexes (S3). `user` validation (S5).

**Verification**
```bash
node --test scripts/issue-claim.test.mjs
pnpm lint
```

### Phase 2 — Workflows (thin glue)

**Task 2.1 — `.github/workflows/assign-issue.yml`.**
- `on: issue_comment: [created]`; job `if:` filters PR comments + non-claim bodies + **bot authors** (`github.event.comment.user.type != 'Bot'`, O5) (cheap gate; authoritative parse via `parseCommand`).
- `permissions: { issues: write, contents: read }`; `concurrency: assign-issue-${{ github.event.issue.number }}` (`cancel-in-progress: false`); `timeout-minutes: 5`.
- Steps: `checkout` (pinned SHA) → `setup-node@…` (node 22) → `github-script@…v9.0.0`.
- **Pass `comment.body` via `env:`**, read `process.env` inside the script — never interpolate untrusted input into `${{ }}` or `run:` (injection guard). `import` the pure fns from `../../scripts/issue-claim.mjs`.
- Claim write: `issues.update(body)` wrapped in a **3-try backoff on 409/422**, re-reading the body per attempt (O2).
- `/unassign` privilege: resolve `privileged` via `repos.getCollaboratorPermissionLevel(actor) ∈ {admin, write}` and pass it into `canUnassign` (O6).
- Native `addAssignees` stays a best-effort no-op, **caught by `error.status`** (swallow 404/422 only; `core.warning` else — O4).

**Task 2.2 — `.github/workflows/stale-assignment-check.yml`.**
- `on: schedule: cron '17 6 * * *'` + `workflow_dispatch`.
- `permissions: { issues: write, pull-requests: read }`; `concurrency`; `timeout-minutes: 10`.
- Sweep: `listForRepo(labels: status: in-progress)` (paginated) → per issue, wrapped in `try/catch` so one poisoned issue can't abort the run (S2): `parseClaimMarker` (skip null), `hasOpenLinkedPr` (skip; fork-source aware, O3), `computeIdleDays`, then `shouldNudge`/release.
- Bot comments carry invisible markers — `<!-- sigma-nudge -->` (nudge) / `<!-- sigma-release -->` (release) — so `shouldNudge` detects a prior nudge deterministically (O1).
- `removeLabel`/`removeAssignees` on release caught **by `error.status`** (404/422 benign; else `core.warning`, O4).

**Verification**
```bash
# YAML/action-pin sanity
grep -rn "github-script@" .github/workflows/assign-issue.yml .github/workflows/stale-assignment-check.yml   # must show the v9.0.0 SHA
# Dry-run the sweep after merge to a branch:
gh workflow run stale-assignment-check.yml --repo <fork>
```

### Phase 3 — Owner steps & docs

**Task 3.1 — Create label** (style-matched to existing `status:`):
```bash
gh label create "status: in-progress" --repo midt-bg/sigma \
  --description "По задачата се работи (заявена чрез /assign)" --color 1d76db
```
**Task 3.2 — `CONTRIBUTING.md`** — one Bulgarian line in the workflow section: *«Коментирай `/assign` преди да започнеш; `/unassign` ако се откажеш. Сложи `Closes #NN` в PR-а.»*
**Task 3.3 — Do NOT** change repo Workflow-permission default (S6). Confirm branch protection allows these workflows (coordinate w/ @cefothe).

**Verification**
```bash
gh label list --repo midt-bg/sigma | grep "in-progress"
```

---

## Testing Strategy

`node --test scripts/issue-claim.test.mjs` (auto-run by `scripts-test.yml`). ~50 cases grouped by function; boundary/adversarial cases explicit.

- **`parseCommand`** (14): `/assign`, `/unassign`, whitespace, trailing text; **exact-word guard rejects** `/assignee`, `/assign-me`, `/assigned`; case-sensitive; empty.
- **`parseClaimMarker`** (8): valid; absent; **malformed JSON → null, no throw (S2)**; missing/non-string `user` → null (S5); mid-body; duplicate markers.
- **`writeClaim`/`stripClaim`** (10): round-trip; re-claim idempotent same user; re-claim different user drops old; **strip removes duplicate banner + duplicate marker (S3 anti-spoof)**; preserves surrounding text.
- **`canUnassign`** (7): self; OWNER/MEMBER/COLLABORATOR release other; CONTRIBUTOR/NONE cannot; unknown assoc → false (allowlist).
- **`computeIdleDays`** (11): single human; **bot nudge must NOT reset clock**; latest human wins; no human → `created_at` fallback; boundaries at 14 & 21; unparseable timestamp excluded, no throw.
- **`hasOpenLinkedPr`** (9): open→true; closed/merged→false; cross-ref to issue (not PR)→false; `source`/`issue`/`repository` null → false, no throw; **fork-source PR still open→true (O3)**.
- **`shouldNudge`** (9): ≥14 & not nudged→true; <14→false; already-nudged (`<!-- sigma-nudge -->` present)→false; **human comment containing the words "auto-release" does NOT suppress (O1)**; a `<!-- sigma-release -->`-marked comment does not count as a nudge; empty timeline→nudge.
- **Composed decision cases** (12): the `/assign`/`/unassign`/sweep outcomes end-to-end over the pure fns (no API).

No mocking of the module under test; feed fixture arrays shaped like octokit responses (mirrors `reap-previews.test.mjs`).

---

## Risk Assessment

| Risk | Sev | Mitigation |
|---|---|---|
| Claim/identity spoofing via editable body (S1) | High | Untrusted-body model; authz off `context` not body; optional bot-comment-of-record (D2) |
| Malformed marker DoSes daily sweep (S2) | High | Guarded parse + `continue`; test 2.3 |
| Sticky claim via duplicate marker (S3) | Med | Global strip regex; tests 3.8/3.9 |
| `.github/` overlap w/ branch-protection thread | Med | Phase 0 coordination w/ @cefothe (per issue) |
| Over-privileging via "Read and write" default (S6) | Med | Drop owner-step #2; per-job permissions only |
| Unenforced convention (PR opened on unclaimed issue) | Low | Accepted (documented in issue); social, not technical |
| 14/21-day windows are guesses | Low | Constants in one module; tune after real data |

---

## Rollout Plan

**Pre-merge:** module tests green; actions SHA-pinned; `@cefothe` sign-off on `.github/`; label created.
**Deploy:** merge to `main` — scheduled sweep goes live from `main` automatically (like `preview-reap.yml`); comment workflow active on next `issue_comment`.
**Post-deploy validation:** (1) `/assign` on a throwaway issue → banner+marker+label appear, confirmation comment posts. (2) `/unassign` clears all three. (3) `workflow_dispatch` the sweep as a dry check. (4) Seed a malformed marker on a test issue, run the sweep, confirm it skips that issue and still processes others (S2 regression).
**Rollback:** delete the two workflow files (idempotent; markers/labels are inert text a maintainer can strip).

---

## Decisions Needed

- **D1 — Model acceptance.** #230 is `needs-decision`. Build only after maintainer go-ahead. *(Recommend: proceed once accepted.)*
- **D2 — Claim of record: body-marker vs bot-comment.** Body-marker matches the draft + `<!-- sigma-preview -->` precedent but is user-editable (S1/S5 mitigated but present). A bot-authored comment is tamper-resistant (`user.type==='Bot'` verifiable) at the cost of more API calls. *(Recommend: ship body-marker with S1/S3/S5 hardening now; note bot-comment as a follow-up if spoofing is observed.)*
- **D3 — Bot reply language.** `CONTRIBUTING.md` mandates Bulgarian user-facing text; the draft replies are English. *(Recommend: Bulgarian replies to match the contributor-facing convention.)*
- **D4 — Two files vs. "three workflows".** The proposal's prose says three; its rollout says two. This plan ships two (linked-PR awareness inline in the sweep). *(Recommend: confirm two; a third file would duplicate the timeline fetch.)*
- Open questions carried from the issue + expanded proposal (all **deferred, out of scope**):
  - Separate `actions/stale` workflow for stale **PRs** (distinct from issue claims)?
  - Per-`priority`-label 14/21-day windows?
  - At what contributor-base size does granting the **Triage role** become worth it (can coexist with this bot)?

---

## Success Criteria

- [ ] Maintainer decision on #230 recorded; `.github/` overlap cleared with @cefothe (Phase 0)
- [ ] `scripts/issue-claim.mjs` — all logic extracted, pure, guarded, `isMain` guard
- [ ] `scripts/issue-claim.test.mjs` — full matrix green under `node --test`
- [ ] Both workflows thin, `github-script@…v9.0.0` SHA-pinned, `timeout-minutes` + `concurrency` + least-priv `permissions`
- [ ] S1/S2/S3/S5 fixes present and test-covered; owner-step "Read and write" **not** applied (S6)
- [ ] Operational fixes O1 (nudge marker), O2 (update retry), O3 (fork-source PR), O4 (status-scoped catch), O5 (bot-author guard), O6 (permission-level override) present and, where pure, test-covered
- [ ] `status: in-progress` label created; `CONTRIBUTING.md` Bulgarian line added
- [ ] `pnpm lint` clean; no secrets; change scoped to `.github/` + `scripts/` + `CONTRIBUTING.md`

---
**Status:** Draft — pending #230 decision
**Created:** 2026-07-14
**Updated:** 2026-07-14 (round-2 operational review: O1–O6 folded in)
**Reviewers:** security-auditor, architect-review, deployment-engineer, test-automator (consensus: accept model, extract + harden)
