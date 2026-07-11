# Smart Commit

Analyze staged git changes and commit them, splitting into multiple focused commits if necessary. All commit messages MUST strictly follow the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification.

## Critical Rules

**ONE-TIME OPERATION.** This command commits only what is currently staged, then STOPS. Do NOT automatically commit any subsequent changes. Future commits require the user to explicitly run this command again.

**NEVER delete, skip, or exclude any staged files.** All staged changes MUST be committed. Your job is to organize and commit what the user staged, not to judge whether files belong.

**ONLY work with staged changes.** Do not touch, stage, or modify unstaged files. If splitting commits, stash unstaged changes first to prevent mixing.

## Instructions

1. **Gather context** by running these commands in parallel:
   - `git diff --staged --name-only` to get the list of staged files (save this list!)
   - `git diff --staged` to see all staged changes
   - `git log --oneline -10` to understand the repository's existing commit style (scopes, casing, body conventions)

2. **Save the original staged file list** — you MUST commit ALL of these files, no exceptions.

3. **Analyze and group changes** by examining:
   - File paths and their logical groupings (e.g., `tests/`, `docs/`, `src/<module>/`)
   - The nature of changes (feature, fix, refactor, perf, docs, test, build, ci, chore, style)
   - Whether any change is **breaking** (backward-incompatible API/behavior change) — these need `!` and/or a `BREAKING CHANGE` footer
   - Dependencies between changes (changes that must go together)

4. **Decide on commit strategy**:
   - If all changes serve a single purpose: one commit
   - If changes span multiple unrelated purposes: split into multiple commits
   - Group by: functionality > module > change type

   Common groupings:
   - Source code changes + their corresponding tests = one commit
   - Documentation updates = separate commit
   - Configuration / tooling changes = separate commit
   - Refactoring = separate commit from features/fixes

5. **Execute commits**:
   - If creating a single commit: commit directly without unstaging
   - If splitting into multiple commits:
     a. Run `git stash --keep-index` to stash unstaged changes (keeps staged intact)
     b. Run `git reset HEAD` to unstage the staged changes
     c. For each commit group, stage files with `git add <files>`
     d. Commit with a Conventional Commits message
     e. Repeat until ALL originally staged files are committed
     f. Run `git stash pop` to restore unstaged changes
   - Use the heredoc form for messages so multi-line bodies/footers render correctly:

     ```bash
     git commit -m "$(cat <<'EOF'
     <type>[optional scope][!]: <description>

     [optional body]

     [optional footer(s)]
     EOF
     )"
     ```

6. **Conventional Commits v1.0.0 — Required Rules** (apply to every commit message):

   Structure:

   ```
   <type>[optional scope][!]: <description>

   [optional body]

   [optional footer(s)]
   ```

   - **Type prefix is required.** The header MUST start with a noun type (`feat`, `fix`, ...), followed by an OPTIONAL scope in parentheses, an OPTIONAL `!`, then a REQUIRED `:` and a single space, then the description.
   - **`feat`** MUST be used when the commit adds a new feature.
   - **`fix`** MUST be used when the commit fixes a bug.
   - **Scope** is optional. When present it MUST be a noun in parentheses describing a section of the codebase (e.g. `fix(parser):`).
   - **Description** MUST immediately follow the `: ` after the type/scope prefix and is a short summary.
   - **Body** is optional. If included, it MUST begin **one blank line** after the description; free-form, may contain multiple newline-separated paragraphs.
   - **Footer(s)** are optional. If included, they MUST begin **one blank line** after the body. Each footer MUST be `<token><sep><value>`, where `<sep>` is `: ` (colon + space) or ` #` (space + hash). The token MUST use `-` instead of whitespace (e.g. `Reviewed-by`, `Refs`, `Closes`). `BREAKING CHANGE` is the only token that uses a literal space.
   - **Breaking changes** MUST be indicated by:
     - `!` immediately before the `:` in the header (e.g. `feat!:`, `refactor(api)!:`), and/or
     - a footer whose token is `BREAKING CHANGE` (or its synonym `BREAKING-CHANGE`), followed by `: ` and a description. The token MUST be uppercase.
   - **Additional types** other than `feat` and `fix` are permitted. Prefer the conventional set below.
   - Output **lowercase** types and scopes for consistency with established convention.

   Allowed types (conventional / Angular / commitlint set):
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

   A breaking change in any type correlates to SemVer **MAJOR**.

   Style guidelines (on top of the spec):
   - Header target ≤ 72 characters; hard upper limit 100.
   - Description: imperative mood, lowercase first word, no trailing period.
   - Body: explain _why_, not _what_. Wrap around 72 characters. Bullet points are acceptable.
   - Do NOT add `Co-Authored-By` or any AI-attribution trailers.

7. **Verify results**:
   - Run `git status` to confirm all originally staged files are now committed
   - Run `git log --oneline -N` (where N = number of commits created) to show the new commits
   - Verify NO originally staged files remain uncommitted
   - Verify unstaged changes are restored (if stash was used)
   - Report the results to the user

## Examples of Good Groupings

**Example 1**: Feature with tests

```
Commit 1: "feat(auth): add user authentication endpoint"
  - src/auth/login.py
  - src/auth/middleware.py
  - tests/auth/test_login.py
```

**Example 2**: Mixed changes

```
Commit 1: "refactor(utils): extract validation helpers"
  - src/utils/validation.py
  - src/handlers/form.py

Commit 2: "docs: update API documentation"
  - docs/api.md
  - README.md

Commit 3: "chore: update linter configuration"
  - .eslintrc
  - pyproject.toml
```

**Example 3**: Breaking change

```
Commit 1: "feat(api)!: drop support for v1 webhook payloads"

  Body:
    Webhook consumers must migrate to the v2 envelope.

  Footer:
    BREAKING CHANGE: v1 webhook envelope is no longer parsed; see
    docs/webhooks/v2.md.

  Files:
    - src/api/webhooks/v2.ts
    - src/api/webhooks/__tests__/v2.test.ts
    - docs/webhooks/v2.md
```

## Split Commit Flow (with unstaged changes protection)

```bash
# 1. Save staged file list
STAGED_FILES=$(git diff --staged --name-only)

# 2. Stash unstaged changes (staged changes remain)
git stash --keep-index

# 3. Reset to unstage (now only originally-staged changes exist in working dir)
git reset HEAD

# 4. Stage and commit each group, using Conventional Commits messages
git add file1.py file2.py
git commit -m "$(cat <<'EOF'
feat(parser): support unicode identifiers
EOF
)"

git add file3.py
git commit -m "$(cat <<'EOF'
fix(parser): close stream on malformed input

Closes #931
EOF
)"

# 5. Restore unstaged changes
git stash pop
```

## Important Notes

- **Commit ALL staged files** — even if a file seems unrelated or temporary, commit it. The user staged it intentionally.
- Never commit files that appear to contain secrets (`.env`, credentials, API keys) — warn the user instead.
- If unsure about grouping, prefer fewer commits over many tiny ones.
- Related test changes should go with their source code changes.
- Configuration for a feature should go with that feature.
- **Always use `git stash --keep-index` before `git reset HEAD`** when splitting commits to protect unstaged changes.
- If `git stash pop` has conflicts, warn the user and help resolve them.
- Every commit message MUST be parseable as Conventional Commits v1.0.0. If a change doesn't fit any standard type, use `chore` rather than inventing a new type.
