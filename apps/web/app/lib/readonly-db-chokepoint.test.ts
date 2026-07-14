import { describe, expect, it } from 'vitest';

// Chokepoint guard (#199): web reads D1 only through @sigma/db's getDb. These are the enforcement in
// place of a lint rule (the repo lints with prettier only). Covers every web source dir — app/,
// workers/, and any root-level apps/web file (#225 review). Comments are stripped so prose that merely
// mentions `env.DB` (e.g. sql-guard.ts) is not a false positive.
const SOURCES: Record<string, string> = import.meta.glob(
  ['../**/*.{ts,tsx}', '../../workers/**/*.{ts,tsx}', '../../*.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// [path, comment-stripped code] for every non-test web source file.
const CODE: ReadonlyArray<readonly [string, string]> = Object.entries(SOURCES)
  .filter(([path]) => !path.includes('.test.'))
  .map(([path, src]) => [path, stripComments(src)] as const);

const offenders = (re: RegExp): string[] =>
  CODE.filter(([, code]) => re.test(code))
    .map(([path]) => path)
    .sort();

describe('read-only D1 chokepoint', () => {
  it('no web source reads env.DB directly (all D1 access goes through getDb)', () => {
    expect(offenders(/\benv\.DB\b/)).toEqual([]);
  });

  // A destructured DB (`const { DB } = context.cloudflare.env`) would hold the raw write-capable binding
  // and slip past the `env.DB` scan above (#225 review).
  it('no web source destructures DB off the env', () => {
    expect(offenders(/\bconst\s*\{[^}]*\bDB\b[^}]*\}\s*=\s*[^;]*\benv\b/)).toEqual([]);
  });

  // getDb throws on .batch()/.withSession()/.dump(); a read-loader calling one would break at runtime and
  // no predicate/corpus test would catch it, so forbid them in web source outright (#225 review).
  it('no web source calls a getDb-blocked method (.batch/.withSession/.dump)', () => {
    expect(offenders(/\.(?:batch|withSession|dump)\s*\(/)).toEqual([]);
  });
});
