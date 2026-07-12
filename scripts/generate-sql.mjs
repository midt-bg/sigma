#!/usr/bin/env node
// Expands `-- @include <fragment>` markers in *.template.sql files into the checked-in *.sql
// files that wrangler/sqlite3/the ETL Worker actually execute. Single source of truth for SQL
// blocks duplicated across normalize-raw.sql and refresh-slice.sql (e.g. the ЕИК control-digit
// checksum) lives in scripts/lib/*.fragment.sql; run this after editing a fragment or a template.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = resolve(root, 'scripts');

const INCLUDE_RE = /^(\s*)-- @include (\S+)$/;

export function expandTemplate(
  templateSql,
  { baseDir = scriptsDir, templateName = '<template>' } = {},
) {
  const lines = templateSql.split('\n');
  const out = [];
  for (const line of lines) {
    const match = line.match(INCLUDE_RE);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, indent, fragmentName] = match;
    if (
      !fragmentName ||
      /^\.*$/.test(fragmentName) ||
      fragmentName.includes('/') ||
      fragmentName.includes('\\') ||
      fragmentName.includes('..') ||
      basename(fragmentName) !== fragmentName
    ) {
      throw new Error(`invalid fragment name in @include: ${fragmentName}`);
    }
    let fragment;
    try {
      fragment = readFileSync(resolve(baseDir, 'lib', fragmentName), 'utf8');
    } catch (cause) {
      throw new Error(
        `failed to @include "${fragmentName}" from ${templateName}: ${cause.message}`,
        { cause },
      );
    }
    const fragmentLines = fragment.replace(/\n$/, '').split('\n');
    for (const fragmentLine of fragmentLines) {
      out.push(fragmentLine.length > 0 ? indent + fragmentLine : fragmentLine);
    }
  }
  return out.join('\n');
}

export const GENERATED_TARGETS = [
  { template: 'normalize-raw.template.sql', output: 'normalize-raw.sql' },
  { template: 'refresh-slice.template.sql', output: 'refresh-slice.sql' },
];

export function generateAll({ write = true } = {}) {
  return GENERATED_TARGETS.map(({ template, output }) => {
    const templatePath = resolve(scriptsDir, template);
    const outputPath = resolve(scriptsDir, output);
    const expanded = expandTemplate(readFileSync(templatePath, 'utf8'), {
      baseDir: scriptsDir,
      templateName: template,
    });
    if (write) writeFileSync(outputPath, expanded, 'utf8');
    return { template, output, outputPath, expanded };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = generateAll({ write: true });
  for (const { template, output } of results) {
    console.log(`==> generated ${output} from ${template}`);
  }
}
