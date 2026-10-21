// The type scale is in rem so the reader's default font size and the accessibility widget's
// „Увеличи шрифта" (a root bump, base.css) both enlarge the text. A px font size outside an SVG
// rule (SVG text is laid out in viewBox units) would ignore both, and `zoom` must not come back.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(__dirname);
const sheets = readdirSync(dir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ file: f, css: readFileSync(resolve(dir, f), 'utf8') }));

// Every `font:` / `font-size:` declaration outside an SVG rule that matches `bad`, with its selector.
function fontSizes(css: string, bad: (decl: string) => boolean) {
  const hits: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    for (const decl of m[2]!.split(';')) {
      if (/^\s*font(-size)?\s*:/.test(decl) && !/svg/.test(selector) && bad(decl))
        hits.push(`${selector} { ${decl.trim()} }`);
    }
  }
  return hits;
}
const everySheet = (bad: (decl: string) => boolean) =>
  sheets.flatMap(({ file, css }) => fontSizes(css, bad).map((h) => `${file}: ${h}`));

describe('type scale', () => {
  it('sizes text in rem, not px, outside SVG', () => {
    expect(everySheet((decl) => /\dpx/.test(decl))).toEqual([]);
  });

  // Captions, card labels, chips and column headers were 9–11 px; 12 px is the floor.
  it('keeps no text below 12 px (0.75rem)', () => {
    const below = (decl: string) =>
      [...decl.matchAll(/(\d*\.?\d+)rem/g)].some((m) => Number(m[1]) < 0.75);
    expect(everySheet(below)).toEqual([]);
  });

  it('enlarges text through the root font size, not zoom', () => {
    for (const { css } of sheets) expect(css).not.toMatch(/(^|[\s;{])zoom\s*:/);
    const base = sheets.find((s) => s.file === 'base.css')!.css;
    expect(base).toMatch(/html\.font-resize\s*\{\s*font-size:\s*125%/);
  });
});
