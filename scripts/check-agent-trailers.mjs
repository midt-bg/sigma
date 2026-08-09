#!/usr/bin/env node
// Refuse `Co-authored-by:` trailers that credit a CODING AGENT.
//
// The repo convention is narrower than it used to read. Trailers naming HUMANS are not just allowed,
// they are load-bearing: GitHub's squash merge builds them from the PR's commit authors, and they are
// the only reason an external contributor keeps credit on `main` (the squash commit's own author is
// always the PR opener). Stripping those would erase the people this project runs on.
//
// What must not appear is an agent: Claude Code, Codex, Cursor, Copilot and friends. They are tools
// the maintainers drive, not contributors, and crediting them as co-authors misrepresents who wrote
// the code. Dependency and CI bots (dependabot, renovate) are deliberately NOT in the list — their
// trailers are how their own automated PRs are attributed, which is a different thing.
//
//   node scripts/check-agent-trailers.mjs <base-sha> <head-sha>
//
// Exits 1 and prints the offending commits when it finds any.
import { execFileSync } from 'node:child_process';

// Matched case-insensitively against the whole trailer line, so either the display name or the
// address is enough. Extend as new agents appear; keep humans and dependency bots out of it.
const AGENTS = [
  'claude',
  'anthropic\\.com',
  'codex',
  'openai\\.com',
  'cursor',
  'copilot',
  'devin',
  'aider',
  'sourcegraph\\.com',
  'sweep-ai',
];

const TRAILER = /^\s*co-authored-by:\s*(.+)$/gim;
const AGENT_RE = new RegExp(AGENTS.join('|'), 'i');

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: check-agent-trailers.mjs <base-sha> <head-sha>');
  process.exit(2);
}

// %H then the body, one record per commit, NUL-separated so multi-line bodies stay intact.
const log = execFileSync('git', ['log', `${base}..${head}`, '--format=%H%n%B%x00'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

const offenders = [];
for (const record of log.split('\0')) {
  const trimmed = record.trim();
  if (!trimmed) continue;
  const [sha, ...rest] = trimmed.split('\n');
  const body = rest.join('\n');
  for (const [, who] of body.matchAll(TRAILER)) {
    if (AGENT_RE.test(who)) offenders.push({ sha: sha.slice(0, 8), who: who.trim() });
  }
}

if (offenders.length === 0) {
  console.log('no agent co-author trailers');
  process.exit(0);
}

console.error('Co-authored-by trailers crediting a coding agent:\n');
for (const o of offenders) console.error(`  ${o.sha}  Co-authored-by: ${o.who}`);
console.error(`
Agents are tools we drive, not contributors. Trailers naming PEOPLE are fine and should stay -
they are how a contributor keeps credit through a squash merge.

To fix without rewriting anyone's branch: the maintainer merging the PR can drop these lines from
the squash message (\`gh pr merge --squash --body "..."\`), which never touches the contributor's
fork. Rewriting published commits is not required and, on a fork, not wanted.
`);
process.exit(1);
