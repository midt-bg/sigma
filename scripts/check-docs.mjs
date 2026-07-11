// Docs integrity gate (#102). Two asserts, mirroring the philosophy of
// scripts/integrity-checks.mjs: don't just print — fail CI on drift.
//
//   1. No dangling refs. Every repo-root-relative `docs/<path>.md` mentioned in
//      source (code comments, README, the docs themselves) must resolve to a
//      real file. Refs inside a URL/longer path are ignored, and test files
//      (*.test.*) are skipped — their doc-shaped strings are fixtures, not refs.
//   2. No orphan docs. Every `docs/**/*.md` must be reachable from the docs index
//      (docs/README.md), or — for ADRs — from docs/adr/README.md. Keeps the
//      index honest so a new doc can't land unlinked.
//
// The scanning/matching logic is pure (strings + path lists) and is exercised
// adversarially by scripts/check-docs.test.mjs; main() wires it to the real repo
// and exits non-zero on the first violation kind found.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where source-level doc references can live. Excludes node_modules, build
// output and the lockfile by construction (we never descend into them).
const SCAN_ROOTS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs',
  'packages',
  'apps',
  'scripts',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.wrangler']);
const TEXT_EXT = /\.(md|ts|tsx|js|mjs|cjs|jsx|sql|json|yml|yaml)$/;
const DOCS_REF = /\bdocs\/[A-Za-z0-9_./-]+\.md\b/g;
// Inline `](path.md)`, with optional `#anchor` and optional `"title"`.
const MD_LINK = /\]\(\s*([^)\s#]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\s*\)/g;
// Reference-style definition `[label]: path.md`.
const MD_REF_LINK = /^\s*\[[^\]]+\]:\s*([^\s#]+\.md)/gm;

// ── pure helpers (unit-tested in check-docs.test.mjs) ──────────────────────────

/** `true` for a markdown doc path. Non-.md files under docs/ (schemas, fixtures) are not docs. */
export function isMarkdown(path) {
  return path.endsWith('.md');
}

/** `true` for a test/spec file — excluded from the ref scan (its doc paths are fixtures). */
export function isTestFile(path) {
  return /\.(test|spec)\.[mc]?[jt]sx?$/.test(path);
}

/** `true` iff this module is the entry point — URL-safe (percent-encoded paths, spaces, non-ASCII). */
export function isMain(importMetaUrl, argvPath) {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(argvPath).href;
}

/**
 * Root-relative `docs/<path>.md` refs in a blob of text. Excludes any occurrence
 * that is a segment inside a URL or a longer path (immediately preceded by `/`):
 * a ref we validate is repo-root-relative, so it is never preceded by `/`.
 */
export function extractDocsRefs(text) {
  const refs = [];
  for (const m of text.matchAll(DOCS_REF)) {
    if (m.index > 0 && text[m.index - 1] === '/') continue; // URL / non-root path segment
    refs.push(m[0]);
  }
  return refs;
}

/**
 * Repo-internal markdown link targets in an index file's text; external URLs skipped.
 * Handles inline links (incl. `#anchor` and `"title"`) and reference-style definitions,
 * so a doc linked in any of those forms is not miscounted as an orphan.
 */
export function linkTargets(text) {
  const targets = [];
  for (const re of [MD_LINK, MD_REF_LINK]) {
    for (const m of text.matchAll(re)) {
      if (/^(https?:)?\/\//.test(m[1])) continue; // external
      targets.push(m[1]);
    }
  }
  return targets;
}

/** Docs not reachable from an index and not explicitly exempt. */
export function computeOrphans(mdDocs, indexed, exempt) {
  return mdDocs.filter((p) => !exempt.has(p) && !indexed.has(p));
}

// ── fs wiring ──────────────────────────────────────────────────────────────────

function walk(abs, out = []) {
  if (!existsSync(abs)) return out;
  const st = statSync(abs);
  if (st.isFile()) {
    if (TEXT_EXT.test(abs)) out.push(abs);
    return out;
  }
  for (const entry of readdirSync(abs)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(abs, entry), out);
  }
  return out;
}

// Markdown link targets of an index file, resolved to repo-relative doc paths.
function linkedFrom(indexAbs) {
  const dir = dirname(indexAbs);
  const linked = new Set();
  for (const target of linkTargets(readFileSync(indexAbs, 'utf8'))) {
    linked.add(relative(ROOT, resolve(dir, target)));
  }
  return linked;
}

export function findDanglingRefs(files) {
  const dangling = [];
  for (const abs of files) {
    for (const ref of extractDocsRefs(readFileSync(abs, 'utf8'))) {
      if (!existsSync(join(ROOT, ref))) {
        dangling.push({ file: relative(ROOT, abs), ref });
      }
    }
  }
  return dangling;
}

export function findOrphanDocs() {
  const docsRoot = join(ROOT, 'docs');
  const allDocs = walk(docsRoot)
    .map((abs) => relative(ROOT, abs))
    .filter(isMarkdown); // only markdown is a "doc" that must be indexed
  const indexed = new Set();
  const topIndex = join(docsRoot, 'README.md');
  const adrIndex = join(docsRoot, 'adr', 'README.md');
  if (existsSync(topIndex)) for (const p of linkedFrom(topIndex)) indexed.add(p);
  if (existsSync(adrIndex)) for (const p of linkedFrom(adrIndex)) indexed.add(p);

  // The index files themselves and the ADR template are reachable by definition.
  const exempt = new Set(['docs/README.md', 'docs/adr/README.md', 'docs/adr/_template.md']);
  return computeOrphans(allDocs, indexed, exempt);
}

function main() {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r))).filter((abs) => !isTestFile(abs));
  const dangling = findDanglingRefs(files);
  const orphans = findOrphanDocs();

  for (const d of dangling) console.error(`dangling docs ref: ${d.ref} (in ${d.file})`);
  for (const o of orphans)
    console.error(`orphan doc (not linked from docs/README.md or docs/adr/README.md): ${o}`);

  if (dangling.length || orphans.length) {
    console.error(
      `\ncheck-docs: ${dangling.length} dangling ref(s), ${orphans.length} orphan doc(s).`,
    );
    process.exit(1);
  }
  console.log('check-docs: ok — all docs refs resolve and every doc is indexed.');
}

if (isMain(import.meta.url, process.argv[1])) main();
