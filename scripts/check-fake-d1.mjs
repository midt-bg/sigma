// Fake-D1 double gate (#325). Mirrors the philosophy of scripts/check-docs.mjs and
// scripts/check-coverage.mjs: don't just print — fail CI on drift.
//
// One assert: outside an explicit by-name allowlist, no file under apps/ or packages/ may type a
// value as a D1Database. That cast is the unambiguous signature of a hand-rolled D1 double, and
// hand-rolled doubles are what #325 exists to remove — every one of them dispatched on
// `sql.includes('…')` and fell through to `{ results: [] }` when the marker stopped matching, so a
// test could go green having asserted nothing. The shared helper in @sigma/test-support throws on an
// unmatched query instead, and it is the only place allowed to hold the cast.
//
// The allowlist is by NAME, never a directory glob — the same argument the #254 review made about
// the coverage exclusion list. A glob lets a new double leave the gate by virtue of where it sits;
// a named entry means a human had to add it, which is reviewable.
//
// A stale allowlist entry (a path that no longer exists) is an error rather than a no-op: otherwise
// a renamed double leaves the gate permanently widened by a line nobody reads again.
//
// The scanning/matching logic is pure and exercised adversarially by scripts/check-fake-d1.test.mjs;
// main() wires it to the real repo.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Exported so the self-test can pin it: a pattern that is right but applied to half the repo is
// a gate that passes while enforcing nothing.
export const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.turbo',
  '.wrangler',
  '.react-router',
  'coverage',
]);

// The only two files in the repo permitted to type a value as D1Database.
export const ALLOWED = [
  // The one shared double. Throws on an unmatched query; everything else routes through it.
  'packages/test-support/src/fake-d1.ts',
  // Not a double at all — a facade that puts the D1 surface on a real node:sqlite database, for the
  // suites that exercise genuine SQL semantics. A different tool, not a competitor; #325 puts
  // replacing real-SQLite tests explicitly out of scope.
  'packages/test-support/src/d1-sqlite.ts',
];

// Both spellings of the cast, plus `satisfies` — the only other operator TypeScript offers for
// giving an object literal that type. The `as unknown as` alternative must come FIRST: the shorter
// spelling is a suffix of the longer one, so a naive pattern reports two casts for one.
const CAST = /\bas\s+unknown\s+as\s+D1Database\b|\bas\s+D1Database\b|\bsatisfies\s+D1Database\b/g;

// One line of indirection defeats CAST: `type DBAlias = D1Database` and then `as unknown as
// DBAlias` carries no D1Database token for the pattern to find. Renaming the type on import,
// intersecting it, picking from it, implementing or extending it all do the same. Giving the type a
// second name outside the allowlist is therefore the offence — there is no honest reason for a test
// to need one.
//
// Best-effort, like every content-mode rule: this reads text, not types, so indirection it cannot
// see (a local module that re-exports the type under another name, a `typeof` on some value) still
// gets through. It closes the spellings a hurried author reaches for, not an author working around
// it on purpose.
//
// The first arm requires the mention to sit where an ALIAS goes — right of `=`, or inside an
// intersection, union, type argument or namespace — never where a PARAMETER or FIELD goes:
// `type Env = { DB: D1Database }` and `type Loader = (db: D1Database) => …` are how honest code
// spells a binding, and a gate that fires on those is one people learn to weaken. `implements` is
// deliberately absent for the same reason: `ReadonlyD1 implements D1Database` is the production
// wrapper doing the real thing, and TypeScript already forces a complete implementation there, so
// it is no shortcut to a stub.
const ALIAS =
  /\btype\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?\s*=[^;\n{]*?(?<=[=&|<,.]\s{0,9})\bD1Database\b|\bD1Database\s+as\s+[A-Za-z_$][\w$]*|\b(?:interface|class)\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?\s+extends\b[^{\n]*\bD1Database\b/g;

// ── pure helpers (unit-tested in check-fake-d1.test.mjs) ───────────────────────

/**
 * Blank out comments, string literals and regex literals, preserving every byte position and line
 * break so hits still report their true line. Casts named in prose — a comment explaining the old
 * design, say — are not casts, and a gate that fires on them is a gate people learn to weaken.
 */
export function blankNonCode(source) {
  const out = [];
  // Where a `/` opens a regex literal rather than dividing. Anything that cannot end an expression
  // must be followed by an operand, so a `/` there starts a regex.
  const BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%~^<>'.split(''));
  let state = 'code';
  let lastSignificant = '';
  let inClass = false; // inside a [...] character class of a regex literal
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out.push(' ', ' ');
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out.push(' ', ' ');
        i += 2;
        continue;
      }
      if (c === '/' && (lastSignificant === '' || BEFORE_REGEX.has(lastSignificant))) {
        state = 'regex';
        inClass = false;
        out.push(' ');
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        out.push(' ');
        i += 1;
        continue;
      }
      out.push(c);
      if (c.trim() !== '') lastSignificant = c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      out.push(blank(c));
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out.push(' ', ' ');
        i += 2;
        continue;
      }
      out.push(blank(c));
      i += 1;
      continue;
    }
    // regex literal and the three string flavours share escape handling
    if (c === '\\') {
      out.push(' ', next === '\n' ? '\n' : ' ');
      i += 2;
      continue;
    }
    if (state === 'regex') {
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        state = 'code';
        lastSignificant = '/';
        out.push(' ');
        i += 1;
        continue;
      } else if (c === '\n') {
        // An unterminated regex means the `/` was division after all — resume reading code.
        state = 'code';
      }
      out.push(blank(c));
      i += 1;
      continue;
    }
    if (c === state) {
      state = 'code';
      lastSignificant = c;
      out.push(' ');
      i += 1;
      continue;
    }
    out.push(blank(c));
    i += 1;
  }
  return out.join('');
}

function scan(pattern, source) {
  const code = blankNonCode(source);
  const hits = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const line = code.slice(0, match.index).split('\n').length;
    hits.push({ line, snippet: match[0].replace(/\s+/g, ' ') });
  }
  return hits;
}

/** Every D1Database cast in `source`, as `{ line, snippet }`, ignoring comments and literals. */
export function findCasts(source) {
  return scan(CAST, source);
}

/**
 * Every second name given to D1Database in `source`. An ordinary annotation — `db: D1Database`, or
 * a field on an Env type — is not one: the gate bans casting a hand-rolled object to the type, not
 * naming the type.
 */
export function findAliases(source) {
  return scan(ALIAS, source);
}

/** Only TypeScript sources can hold the cast; .mjs scripts and data files cannot. */
export function isScannable(path) {
  return /\.tsx?$/.test(path);
}

/** Allowlist entries that no longer name a real file — a widened gate nobody is watching. */
export function staleAllowlistEntries(allowed, presentPaths) {
  return allowed.filter((entry) => !presentPaths.has(entry));
}

/** `true` iff this module is the entry point — URL-safe. */
export function isMain(importMetaUrl, argvPath) {
  return Boolean(argvPath) && importMetaUrl === pathToFileURL(argvPath).href;
}

// ── entry point ────────────────────────────────────────────────────────────────

function walk(absDir) {
  if (!existsSync(absDir)) return [];
  const found = [];
  for (const entry of readdirSync(absDir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(absDir, entry);
    if (statSync(abs).isDirectory()) found.push(...walk(abs));
    else found.push(abs);
  }
  return found;
}

function main() {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .map((abs) => relative(ROOT, abs))
    .filter(isScannable)
    .sort();

  const stale = staleAllowlistEntries(ALLOWED, new Set(files));
  if (stale.length > 0) {
    for (const entry of stale) {
      console.error(
        `check-fake-d1: allowlisted file no longer exists: ${entry} — remove the entry from ALLOWED ` +
          'in scripts/check-fake-d1.mjs rather than leaving the gate widened for a path nobody reads.',
      );
    }
    process.exit(1);
  }

  const allowed = new Set(ALLOWED);
  const offenders = [];
  const aliases = [];
  let castCount = 0;
  for (const file of files) {
    if (allowed.has(file)) continue;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const hits = findCasts(source);
    if (hits.length > 0) {
      offenders.push({ file, hits });
      castCount += hits.length;
    }
    for (const hit of findAliases(source)) aliases.push({ file, hit });
  }

  if (aliases.length > 0) {
    for (const { file, hit } of aliases) console.error(`${file}:${hit.line}: ${hit.snippet}`);
    console.error(
      `\ncheck-fake-d1: ${aliases.length} second name(s) for D1Database outside the allowlist. ` +
        'Casting to an alias is still casting to D1Database, and the gate cannot see it — build ' +
        'the double with fakeD1()/recordingD1()/throwingD1() from @sigma/test-support (#325).',
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    for (const { file, hits } of offenders) {
      for (const hit of hits) console.error(`${file}:${hit.line}: ${hit.snippet}`);
    }
    console.error(
      `\ncheck-fake-d1: ${castCount} D1Database cast(s) in ${offenders.length} file(s) outside the ` +
        'allowlist. Build the double with fakeD1()/recordingD1()/throwingD1() from ' +
        '@sigma/test-support instead — it throws on an unmatched query rather than silently ' +
        'returning no rows (#325).',
    );
    process.exit(1);
  }
  console.log(
    `check-fake-d1: ok — ${files.length} file(s) scanned, no D1Database cast outside the ${ALLOWED.length} allowlisted.`,
  );
}

if (isMain(import.meta.url, process.argv[1])) main();
