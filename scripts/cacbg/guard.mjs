// Refuse-to-run guard (spec §8). CACBG declarations touch PII-adjacent data. The crawl/extract steps are
// only allowed to write under scratch/, and scratch/ MUST be git-ignored so nothing PII lands in a
// commit. This asserts that invariant before any fetch — if scratch/ is not ignored, we stop hard.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRATCH = path.join(ROOT, 'scratch', 'cacbg');

export function assertScratchIgnored() {
  const probe = path.join('scratch', 'cacbg', '.probe');
  try {
    execFileSync('git', ['check-ignore', '-q', probe], { cwd: ROOT });
  } catch {
    throw new Error(
      `REFUSE TO RUN: ${probe} is not git-ignored — add scratch/ to .gitignore first (PII rail, spec §8)`,
    );
  }
}

// Path-sanitize an xml_file / year from the untrusted list.xml before using it in a filesystem path
// or URL. Rejects traversal, absolute paths, and anything outside the expected shape.
export function safeXmlFile(name) {
  const base = path.basename(String(name));
  if (!/^[A-Za-z0-9._-]+\.xml$/.test(base)) throw new Error(`unsafe xmlFile: ${name}`);
  return base;
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
