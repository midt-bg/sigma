# Suggest Commit Message

Analyze the currently staged git changes and propose a commit message that strictly follows the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification.

## Instructions

1. Run `git diff --staged` to see all staged changes.
2. Run `git log --oneline -10` to understand the repository's existing commit style (scopes used, casing, body conventions).
3. Analyze the staged changes to identify:
   - Files modified, added, or deleted
   - The nature of the change (new feature, bug fix, refactor, docs, perf, test, build, ci, chore, style)
   - Whether the change introduces a backward-incompatible API or behavior change (a _breaking change_)
   - The scope — the section of the codebase affected (module, package, component)
4. Compose the commit message in this exact structure:

   ```
   <type>[optional scope][!]: <description>

   [optional body]

   [optional footer(s)]
   ```

5. Present the suggested message inside a single fenced code block so it can be copied verbatim.
6. If the staged changes mix unrelated purposes, recommend splitting them and provide one Conventional Commits message per proposed commit.

## Conventional Commits v1.0.0 — Required Rules

The spec rules below MUST be respected. Quoted/paraphrased from <https://www.conventionalcommits.org/en/v1.0.0/>:

- **Type prefix is required.** The header MUST start with a noun type (`feat`, `fix`, ...), followed by an OPTIONAL scope, an OPTIONAL `!`, then a REQUIRED `:` and a single space, then the description.
- **`feat`** MUST be used when the commit adds a new feature.
- **`fix`** MUST be used when the commit fixes a bug.
- **Scope** is optional. When present it MUST be a noun in parentheses describing a section of the codebase, e.g. `fix(parser):`.
- **Description** MUST immediately follow the `: ` after the type/scope prefix and is a short summary of the change.
- **Body** is optional. If included, it MUST begin **one blank line** after the description. It is free-form and MAY consist of any number of newline-separated paragraphs.
- **Footer(s)** are optional. If included, they MUST begin **one blank line** after the body. Each footer MUST be `<token><sep><value>` where `<sep>` is either `: ` (colon + space) or ` #` (space + hash). The token MUST use `-` instead of whitespace (e.g. `Reviewed-by`, `Acked-by`, `Refs`, `Closes`). The token `BREAKING CHANGE` is the **only** exception and uses a literal space.
- **Breaking changes** MUST be indicated in one of two ways (or both):
  - append `!` immediately before the `:` in the header (e.g. `feat!:`, `refactor(api)!:`), and/or
  - add a footer whose token is `BREAKING CHANGE` (or its synonym `BREAKING-CHANGE`), followed by `: ` and a description.
- **`BREAKING CHANGE`** in a footer MUST be uppercase.
- **Additional types** other than `feat` and `fix` are permitted. Prefer the conventional set listed below before inventing new ones.
- Per the spec, units of information are not case-sensitive (except `BREAKING CHANGE`), but this command outputs **lowercase** types and scopes for consistency with established convention.

## Allowed Types (Angular / commitlint conventional set)

- `feat` — new feature (SemVer **MINOR**)
- `fix` — bug fix (SemVer **PATCH**)
- `build` — build system or external dependencies
- `chore` — maintenance that doesn't change src or tests
- `ci` — CI configuration and scripts
- `docs` — documentation only
- `perf` — performance improvement
- `refactor` — code change that neither fixes a bug nor adds a feature
- `style` — formatting / whitespace / semicolons (no logic change)
- `test` — adding or correcting tests

A breaking change in any of the above correlates to SemVer **MAJOR**.

## Style Guidelines (on top of the spec)

These are conventions layered on top of the spec for readability:

- Header target ≤ 72 characters; hard upper limit 100.
- Description: imperative mood, lowercase first word, no trailing period (e.g. `add login button`, not `Added login button.`).
- Body: explain the _why_ and any non-obvious context, not the _what_ (the diff already shows that). Wrap lines around 72 characters. Bullet points are acceptable.
- Match the scope vocabulary already in this repo's `git log`.

## Examples

Plain feature:

```
feat(auth): add password reset endpoint
```

Fix with body and issue references:

```
fix(parser): handle trailing comma in object literal

The trailing-comma check ran before the spread/rest pass, so valid
ES2017 input was rejected.

Refs: #482
Reviewed-by: Z
```

Breaking change signalled with `!` and explained in a footer:

```
feat(api)!: drop support for v1 webhook payloads

BREAKING CHANGE: webhook consumers must migrate to the v2 envelope
described in docs/webhooks/v2.md. The v1 envelope is no longer parsed.
```

Breaking change via footer only (using the `BREAKING-CHANGE` synonym):

```
refactor(config): split runtime config from build-time config

BREAKING-CHANGE: `app.config.ts` no longer exports `buildEnv`; import
from `app.build-config.ts` instead.
```

Footer using the ` #` separator for an issue reference:

```
fix(ui): prevent double-submit on slow networks

Closes #1184
```
