/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function checksumBlocks(path: string): string[] {
  const sql = readFileSync(path, 'utf8');
  const pattern =
    /^[ \t]*CASE\r?\n(?=[ \t]+WHEN eik_clean IS NULL\b[^\r\n]*LENGTH\(eik_clean\) NOT IN \(9, 13\) THEN 0$)[\s\S]*?^[ \t]*END AS eik_valid$/gm;

  return [...sql.matchAll(pattern)].map(([block]) => {
    const lines = block.split(/\r?\n/);
    const indentation = Math.min(
      ...lines.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0),
    );
    return lines.map((line) => line.slice(indentation)).join('\n');
  });
}

describe('ЕИК checksum copies stay consistent', () => {
  it('keeps every checksum CASE block textually identical', () => {
    const normalizeBlocks = checksumBlocks(resolve(root, 'scripts/normalize-raw.sql'));
    const refreshBlocks = checksumBlocks(resolve(root, 'scripts/refresh-slice.sql'));
    const blocks = [...normalizeBlocks, ...refreshBlocks];

    expect(normalizeBlocks).toHaveLength(3);
    expect(refreshBlocks).toHaveLength(4);
    expect(new Set(blocks)).toEqual(new Set([blocks[0]]));
  });
});
