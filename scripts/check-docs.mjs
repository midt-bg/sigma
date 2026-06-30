// Docs integrity gate (#102). Two asserts, mirroring the philosophy of
// scripts/integrity-checks.mjs: don't just print — fail CI on drift.
//
//   1. No dangling refs. Every `docs/<path>.md` mentioned in source (code
//      comments, README, the docs themselves) must resolve to a real file.
//      This is the bug class #102 fixed: the schema header and several modules
//      pointed at ETL/scope docs (by paths under docs/) that did not exist.
//   2. No orphan docs. Every docs/**/*.md must be reachable from the docs index
//      (docs/README.md), or — for ADRs — from docs/adr/README.md. Keeps the
//      index honest so a new doc can't land unlinked.
//
// Pure checks over an injected file tree so the logic is testable; main() wires
// it to the real repo and exits non-zero on the first violation kind found.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where source-level doc references can live. Excludes node_modules,
// build output and the lockfile by construction (we never descend into them).
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
const MD_LINK = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;

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

// Resolve the targets of every markdown link in a given index file, relative to
// that file's directory, into repo-relative doc paths.
function linkedFrom(indexAbs) {
  const dir = dirname(indexAbs);
  const text = readFileSync(indexAbs, 'utf8');
  const linked = new Set();
  for (const m of text.matchAll(MD_LINK)) {
    const target = m[1];
    if (/^(https?:)?\/\//.test(target)) continue; // external
    linked.add(relative(ROOT, resolve(dir, target)));
  }
  return linked;
}

export function findDanglingRefs(files) {
  const dangling = [];
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(DOCS_REF)) {
      const ref = m[0];
      if (!existsSync(join(ROOT, ref))) {
        dangling.push({ file: relative(ROOT, abs), ref });
      }
    }
  }
  return dangling;
}

export function findOrphanDocs() {
  const docsRoot = join(ROOT, 'docs');
  const allDocs = walk(docsRoot).map((abs) => relative(ROOT, abs));
  const indexed = new Set();
  const topIndex = join(docsRoot, 'README.md');
  const adrIndex = join(docsRoot, 'adr', 'README.md');
  if (existsSync(topIndex)) for (const p of linkedFrom(topIndex)) indexed.add(p);
  if (existsSync(adrIndex)) for (const p of linkedFrom(adrIndex)) indexed.add(p);

  // The index files themselves and the ADR template are reachable by definition.
  const exempt = new Set(['docs/README.md', 'docs/adr/README.md', 'docs/adr/_template.md']);
  return allDocs.filter((p) => !exempt.has(p) && !indexed.has(p));
}

function main() {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));
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

if (import.meta.url === `file://${process.argv[1]}`) main();
