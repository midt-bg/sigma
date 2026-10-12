/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const db = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(db, 'migrations');

/** `sha256sum` lines: the hash, two spaces, the file name. */
function lock(): Map<string, string> {
  return new Map(
    readFileSync(resolve(db, 'migrations.lock'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const match = /^([0-9a-f]{64}) {2}(\S+\.sql)$/.exec(line);
        if (!match) throw new Error(`malformed migrations.lock line: ${JSON.stringify(line)}`);
        return [match[2]!, match[1]!] as const;
      }),
  );
}
const sha256 = (file: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(dir, file)))
    .digest('hex');

// A served database records a migration by name in its ledger and never runs it again, so an edit to an
// applied migration reaches only databases built after it — the drift that once split 0000_init.sql from
// what production holds. A change to the schema is a new migration; the lock makes an edit fail here.
describe('migrations.lock', () => {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('holds every migration, in order, and nothing else', () => {
    const missing = files.filter((f) => !lock().has(f));
    expect(
      missing.map((f) => `${sha256(f)}  ${f}`),
      'add these lines to packages/db/migrations.lock',
    ).toEqual([]);
    expect([...lock().keys()]).toEqual(files);
  });

  it('matches every migration byte for byte', () => {
    const edited = files.filter((f) => lock().has(f) && lock().get(f) !== sha256(f));
    expect(edited, 'an applied migration is never edited: write a new one instead').toEqual([]);
  });

  it('keeps 0000_init.sql as the text first applied to served databases', () => {
    expect(lock().get('0000_init.sql')).toBe(
      'ffc441ed6203c57317acedc8e3b98c7dee929fb3f25f2b134f31b029341374ae',
    );
  });
});
