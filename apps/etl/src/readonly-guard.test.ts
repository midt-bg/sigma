/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ETL keeps the write-capable D1 binding (#199): the read-only wrapper must never reach the ETL worker,
// which legitimately writes D1 (staging / refresh-slice). Importing readonlyD1 here would break ingest.
// Walk the sources with fs (not import.meta.glob) so this guard needs no Vite types in the Worker package.
const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/etl/src

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsSources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(path);
  }
  return out;
}

describe('ETL retains the write-capable D1 binding', () => {
  it('no ETL source imports the read-only wrapper', () => {
    const offenders = tsSources(SRC_DIR)
      .filter((path) => /\breadonlyD1\b/.test(readFileSync(path, 'utf8')))
      .sort();
    expect(offenders).toEqual([]);
  });
});
