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

// Every `font:` / `font-size:` declaration with a px value, tagged with the selector it sits in.
function pxFontSizes(css: string) {
  const hits: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    for (const decl of m[2]!.split(';')) {
      if (/^\s*font(-size)?\s*:.*\dpx/.test(decl) && !/svg/.test(selector))
        hits.push(`${selector} { ${decl.trim()} }`);
    }
  }
  return hits;
}

describe('type scale', () => {
  it('sizes text in rem, not px, outside SVG', () => {
    expect(sheets.flatMap(({ file, css }) => pxFontSizes(css).map((h) => `${file}: ${h}`))).toEqual(
      [],
    );
  });

  it('enlarges text through the root font size, not zoom', () => {
    for (const { css } of sheets) expect(css).not.toMatch(/(^|[\s;{])zoom\s*:/);
    const base = sheets.find((s) => s.file === 'base.css')!.css;
    expect(base).toMatch(/html\.font-resize\s*\{\s*font-size:\s*125%/);
  });
});
