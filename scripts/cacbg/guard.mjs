// Refuse-to-run guard (spec §8). CACBG declarations touch PII-adjacent data. The crawl/extract steps are
// only allowed to write under scratch/, and scratch/ MUST be git-ignored so nothing PII lands in a
// commit. This asserts that invariant before any fetch — if scratch/ is not ignored, we stop hard.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// One environment for every git the rails spawn: inherited GIT_DIR / GIT_WORK_TREE would substitute a
// DIFFERENT repository's answer for the filesystem's (review rounds 3-4 demonstrated it against both
// rails), and LC_ALL=C pins git's messages to English — this machine runs bg_BG, where a localized
// „not a git repository" would turn every legitimate outside-repo override into a refusal.
function gitEnv() {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  // Re-set AFTER the sweep: without it git stops repository discovery at filesystem boundaries, and a
  // mount point INSIDE an outer worktree reports the accepted „not a repository" while that worktree
  // can track the mounted path (review round 4, truncated finding). Forcing discovery across mounts
  // keeps the every-containing-worktree walk honest. Untestable without root (a bind mount), so this
  // line carries the reasoning instead of a fixture.
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '1';
  return env;
}
export const SCRATCH = path.join(ROOT, 'scratch', 'cacbg');

/**
 * Assert that a `scratch/<subdir>` tree is git-ignored, before anything writes PII into it.
 * Parameterised rather than copied: the Trade Register leg needs the identical rail for its deed
 * cache (owner names, company addresses — ADR-0033 decision 5), and a second copy of a safety rail
 * drifts from the original. Existing no-argument callers are unaffected.
 * @param {string} [subdir] directory under scratch/ to probe
 */
export function assertScratchIgnored(subdir = 'cacbg') {
  const probe = path.join('scratch', subdir, '.probe');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', probe], { cwd: ROOT, env: gitEnv() });
  } catch {
    throw new Error(
      `REFUSE TO RUN: ${probe} is not git-ignored — add scratch/ to .gitignore first (PII rail, spec §8)`,
    );
  }
}

/**
 * The same PII rail for an OVERRIDDEN output directory (the CACBG_RAW / CACBG_STAGING test seams).
 * assertScratchIgnored probes the fixed scratch/ location, so a caller that redirects its I/O elsewhere
 * would sail past it — the review demonstrated extract writing related.jsonl (third-party names) into a
 * TRACKED directory via CACBG_STAGING. The rule an override must satisfy is the same one scratch/
 * satisfies: nothing PII may land where git can commit it. So: outside the repository entirely (temp
 * dirs — where every test points) is fine; inside it, the directory must be git-ignored.
 * @param {string} dir absolute or relative path the override points at
 * @param {string} name the env var being validated, for the error message
 */
export function assertOverrideDirSafe(dir, name) {
  const refuse = (why) => {
    throw new Error(
      `REFUSE TO RUN: ${name}=${dir} ${why} — PII output must never be committable (PII rail, spec §8)`,
    );
  };
  // The directory may not exist yet (extract creates staging): walk up to the deepest existing
  // ancestor; the missing tail is re-appended for the ignore checks below.
  const missing = [];
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  // Canonicalize BEFORE judging (review round 4, truncated finding): git already resolves symlinks for
  // its own cwd, but the ignore verdict was being passed the LEXICAL name — an ignored symlink
  // `scratch/leak` pointing at `scripts/` was judged as scratch/… while extraction wrote through it
  // into committable files. Judging the resolved location closes that.
  try {
    probe = fs.realpathSync(probe);
  } catch {
    refuse('could not be verified (the existing ancestor could not be resolved)');
  }
  const target = path.join(probe, ...missing);
  // Git must answer for the FILESYSTEM location. An inherited GIT_DIR / GIT_WORK_TREE would let the
  // caller substitute another repository's ignore policy for the one that actually contains the path
  // (review round 3: reproduced — an alternate repo's exclude rules accepted a tracked sink/).
  const env = gitEnv();
  const gitTop = (cwd) => {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    } catch (e) {
      // Only a CONFIRMED "not a repository" may pass. Every other failure — git missing, permission
      // errors, a corrupt repository — leaves the question unanswered, and an unanswered safety
      // question fails closed (review round 3: EPERM and invalid setups all used to PASS).
      const msg = `${e.stderr ?? ''}${e.message ?? ''}`;
      if (/not a git repository/i.test(msg)) return null;
      refuse(`could not be verified (git failed from ${cwd}: ${String(msg).split('\n')[0]})`);
    }
  };
  // EVERY containing worktree must ignore the target, not just the innermost: a nested repository that
  // ignores the path proves nothing about an OUTER repository that tracks the same tree (review round
  // 3: reproduced — inner repo ignored sink/, outer repo held inner/sink/related.jsonl as committable).
  let cwd = probe;
  for (let depth = 0; depth < 64; depth++) {
    const top = gitTop(cwd);
    if (top === null) return; // no (further) repository contains it
    const rel = path.relative(top, target);
    if (rel === '' || rel === '.')
      refuse('IS a git worktree root — everything under it defaults to committable');
    // `./`-prefix the pathspec: `--` does NOT disable git's pathspec magic, so a directory literally
    // named `:(top)scratch/…` is evaluated as MAGIC — resolving to an ignored path and certifying a
    // committable one (review round 4; verified: check-ignore answers 0 for it). --literal-pathspecs is
    // NOT usable here — check-ignore rejects the literal magic flag while still evaluating :(top) — but
    // a leading ./ keeps the name a name for both commands (verified both directions).
    // TRACKED beats ignored. Ignore rules never apply to paths already in the index, and check-ignore
    // can even answer "ignored" for them (a nested repository makes everything beneath it implicitly
    // ignored — truthful for ADDING files, silent about ones tracked BEFORE the nested repo appeared;
    // review round 3 reproduced exactly that committable leak). If any file under the target is in
    // this worktree's index, modifications are committable regardless of every pattern.
    let tracked;
    try {
      tracked = execFileSync('git', ['ls-files', '-z', '--', `./${rel}`], {
        cwd: top,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      refuse(`could not be verified (git ls-files failed in ${top})`);
    }
    // Decided OUTSIDE the try — a refusal thrown inside it would be swallowed by our own catch and
    // re-dressed as a verification failure (caught by the fixture's message assertion, usefully).
    if (tracked.length > 0)
      refuse(`overlaps files TRACKED in the git worktree at ${top} — already committable`);
    try {
      execFileSync('git', ['check-ignore', '-q', '--', `./${rel}`], {
        cwd: top,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      if (e.status === 1)
        refuse(`points inside the git worktree at ${top} at a path git does not ignore`);
      refuse(`could not be verified (git check-ignore failed in ${top})`);
    }
    const above = path.dirname(top);
    if (above === top) return; // filesystem root
    cwd = above;
  }
  refuse('could not be verified (worktree nesting exceeded 64 levels)');
}

// Path-sanitize an xml_file / year from the untrusted list.xml before using it in a filesystem path
// or URL. Rejects traversal, absolute paths, and anything outside the expected shape.
// The shape of a real declaration filename. Single source of truth for both the throwing guard below
// (used on the fetch path) and the boolean twin (used by parseList to tell a real row from a phantom).
const XML_FILE_SHAPE = /^[A-Za-z0-9._-]+\.xml$/;

export function safeXmlFile(name) {
  const base = path.basename(String(name));
  if (!XML_FILE_SHAPE.test(base)) throw new Error(`unsafe xmlFile: ${name}`);
  return base;
}

/**
 * Does this value name a declaration file at all? The boolean twin of safeXmlFile — same shape, no throw.
 * parseList needs the question answered without an exception because a non-answer there is not an error:
 * the register's list.xml carries placeholder rows (`<xmlFile>U</xmlFile>`) that announce no document.
 * @returns {boolean}
 */
export function isXmlFile(name) {
  return XML_FILE_SHAPE.test(path.basename(String(name ?? '')));
}

export function safeYear(year) {
  const y = String(year);
  if (!/^20\d{2}$/.test(y)) throw new Error(`unsafe year: ${year}`);
  return y;
}

// A declaration-set folder id from the register index. Not just a year: the register uses suffixed
// folders (2021_nc, 2019e, 2024f1, 2025y, 2018h). Constrain to a starts-with-year + short alnum/_
// shape so a hostile index can't inject a path segment.
export function safeFolder(folder) {
  const f = String(folder);
  if (!/^20\d{2}[A-Za-z0-9_]{0,8}$/.test(f)) throw new Error(`unsafe folder: ${folder}`);
  return f;
}
