// Typography of the Bulgarian copy the pages and components write themselves. Every string literal,
// template part and JSX text that holds Cyrillic is checked against the house rules: „…“ quotes (never a
// straight " closing them), a spaced em dash instead of a spaced hyphen, a no-break space before „г.“ after
// a year and inside a grouped number, no em dash glued to the next word. Text that comes from the data
// (registry names, contract titles) is not in the source and is not checked here.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// The privacy notice and the accessibility statement are legal texts with their own review; the assistant
// is switched off.
const SKIP =
  /\.test\.|test-support|\/assistant\/|routes\/privacy\.tsx$|routes\/accessibility\.tsx$/;

const RULES: Array<[string, RegExp]> = [
  ['straight quote in Bulgarian copy — use „…“', /"|&quot;/],
  ['spaced hyphen used as a dash — use „ — “', /[а-яА-Я)\d] - [а-яА-Я(\d]/],
  ['ordinary space before „г.“ — use a no-break space', /(^|\d) г\./],
  ['ordinary space inside a grouped number — use a no-break space', /\d \d{3}(?!\d)/],
  ['em dash glued to a word', /[а-яА-Я] —[а-яА-Я]|[а-яА-Я]—[а-яА-Я]/],
  ['double period', /[а-яА-Я]\.\.(?!\.)/],
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !SKIP.test(path) ? [path] : [];
  });
}

function copyViolations(file: string, text: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split('\n');
  const found: string[] = [];
  const check = (copy: string, node: ts.Node) => {
    if (!/[а-яА-Я]/.test(copy)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    // A string that must stay byte-exact (a file name in the source) is marked on the line above.
    if (lines[line - 2]?.includes('copy-typography: ignore')) return;
    for (const [rule, re] of RULES)
      if (re.test(copy)) found.push(`${file}:${line} ${rule}: ${copy}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) check(node.text, node);
    else if (ts.isJsxText(node)) check(node.text.replace(/\s*\n\s*/g, ' '), node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // An em dash before an element on the same line: „връзките —<strong>…“.
  lines.forEach((l, i) => {
    if (/ —<[a-z]/i.test(l))
      found.push(`${file}:${i + 1} em dash glued to an element: ${l.trim()}`);
  });
  return found;
}

describe('typography of the page copy', () => {
  it('follows the house rules in every route and component', () => {
    const found = sources(ROOT).flatMap((f) =>
      copyViolations(relative(ROOT, f), readFileSync(f, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('catches each rule on a known-bad sample', () => {
    const bad = [
      `const a = 'връзка „декларация" сочи';`,
      `const b = <p>за „{q}". Пробвай</p>;`,
      `const c = 'без граница - същият обхват';`,
      `const d = \`за \${range} г.\`;`,
      `const e = 'под 1 000 €';`,
      `const f = <p>а решенията —<strong>всяка</strong></p>;`,
      `const g = 'деня на публикуване г.. Свалят се';`,
    ];
    for (const sample of bad) expect(copyViolations('x.tsx', sample)).not.toEqual([]);
    const ok = `const ok = 'връзка „декларация“ — за 2026\u00a0г.';`;
    expect(copyViolations('x.tsx', ok)).toEqual([]);
    // the marker on the line above exempts a byte-exact string
    const exempt = `// copy-typography: ignore\nconst n = 'на 2026 г.';`;
    expect(copyViolations('x.ts', exempt)).toEqual([]);
  });
});
