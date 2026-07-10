import { describe, expect, it } from 'vitest';

// Chokepoint guard (#199): web reads D1 only through @sigma/db's getDb — never `env.DB` directly. A raw
// `env.DB` anywhere in web is a write-capable handle that bypasses the read-only wrapper (enforcement in
// place of a lint rule; the repo lints with prettier only). Comments are stripped so prose that merely
// mentions `env.DB` (e.g. sql-guard.ts) is not a false positive.
const SOURCES: Record<string, string> = import.meta.glob(
  ['../**/*.{ts,tsx}', '../../workers/**/*.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('read-only D1 chokepoint', () => {
  it('no web source reads env.DB directly (all D1 access goes through getDb)', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.includes('.test.'))
      .filter(([, src]) => /\benv\.DB\b/.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });
});
