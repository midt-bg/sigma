---
version: '1.0'
description: 'Collaborative design spec workflow — discuss ideas, then capture agreed decisions in a markdown file'
argument-hint: '<specify goal.md location and/or brief goal definition>'
allowed-tools:
  [
    'Bash(*)',
    'Read(*)',
    'Write(*.md)',
    'Edit(*.md)',
    'Glob(*)',
    'Grep(*)',
    'Task(*)',
    'WebFetch(*)',
    'WebSearch(*)',
    'mcp__*',
  ]
---

# Define — Collaborative Design Spec Workflow

You are entering a collaborative design discussion with the user. The goal is to
iterate on ideas together, then capture agreed decisions in a markdown spec file.

## Workflow

1. **One item at a time** — Work through items sequentially. For each item:
   discuss first, agree, then write. Don't jump ahead to the next item until the
   current one is resolved.
2. **Discuss** — The user proposes ideas. You ask questions, suggest alternatives,
   raise concerns, and help refine the thinking. Stay conversational.
3. **Agree** — Wait for the user to explicitly confirm a decision before writing.
   Don't assume agreement from silence, from you proposing something, or from
   the item merely being listed.
4. **Write** — When the user says to write it down, write ONLY the agreed item
   into the spec. Then move on to discussing the next item.

## Rules

- **Never bulk-write remaining items.** If 3 of 7 items are agreed and written,
  do NOT write items 4-7 just because they exist. Each item must go through
  discuss → agree → write individually.
- **Do NOT edit the spec file unless the user explicitly asks you to.**
  Discussion is not agreement. Your suggestions are not decisions.
- **Single document.** Keep everything in one file. Only split into a sub-file
  (e.g. `16_1_subtopic.md`) if the user explicitly says it's too long.
- **Go back and edit.** Previously written items can be revisited at any time.
  If the user wants to revise an earlier section, edit it in place.
- **Combine items.** If multiple items address the same problem area, suggest
  merging them. Write the combined version only after the user agrees.
- **Keep changes minimal.** Only write what was agreed. No drive-by cleanups,
  no extra improvements, no reformatting of unrelated sections.
- **Do NOT touch source code.** This workflow is for spec/design docs only.
  Code changes happen in a separate step when the user asks.
- **Stay in discussion mode by default.** Answer questions, explore tradeoffs,
  show examples — but don't jump to editing files.
- **When you do edit, show what you changed.** After editing, briefly list
  which sections were updated and why.

## Document Format

When the target spec is in the refactoring docs folder, use this format:

```markdown
## Agent Implementation Prompt — [Short Title]

### Context

[1-3 paragraphs: what is being replaced/added and. Include prerequisites.]

### Problem

[P1, P2, ... — numbered problems with code snippets showing the current issue.
Skip this section if there is no existing problem to fix.]

### Design — [Design Name]

[Core design with formulas, code blocks, and rationale.
Use #### subsections for distinct components.]

### Phases / Timing / other design tables

[Tables for phase transitions, parameter changes, etc. as needed.]

### Changes

[Numbered list. Each item:]

1. **[Verb] [Component]**
   (file: `relative/path.py`, optional line hint)
   - Bullet points describing what to do
   - Code snippets for non-obvious logic
   - Parameters and their types/defaults

### Key files

- NEW: file.py — one-line description
- MODIFY: file.py — one-line description
- DELETE: file.py — one-line description
- EXISTING: file.py:function() (reused as-is)
- REFERENCE: paper.tex line N

### Verification

[Numbered list: unit tests, backtest commands, diagnostic logging checks.]
```

Key conventions:

- File numbering: `N_short_name.md` (e.g. `10_unified_quoter.md`)
- Sub-items use `N_M` (e.g. `3_1_net_hedging.md`, `3_2_gross_hedging.md`)
- The doc is an **agent implementation prompt** — written so an agent can
  execute the changes without additional context
- Keet it short and focused using mostly bullet point format
- Code snippets use proper language annotations; formulas use inline backtick notation
- Config changes list Add/Remove/Keep explicitly

## Arguments

If the user provides a file path as argument (e.g. `/define path/to/goal.md`),
that is the target spec file for this session. Otherwise, ask which file to use.

Target spec file: $ARGUMENTS
