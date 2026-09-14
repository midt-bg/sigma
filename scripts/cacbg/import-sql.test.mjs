import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { importSql } from './import-sql.mjs';

test('D1 SQL imports in one transaction and a failed import rolls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma import '));
  const sql = join(dir, 'source.sql'),
    db = join(dir, 'db.sqlite');
  try {
    writeFileSync(
      sql,
      'PRAGMA defer_foreign_keys=TRUE; CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1);',
    );
    importSql(db, sql);
    let read = new DatabaseSync(db);
    assert.equal(read.prepare('SELECT COUNT(*) n FROM sample').get().n, 1);
    read.close();
    writeFileSync(sql, 'INSERT INTO sample VALUES(2); INSERT INTO absent VALUES(3);');
    assert.throws(() => importSql(db, sql));
    read = new DatabaseSync(db);
    assert.equal(read.prepare('SELECT COUNT(*) n FROM sample').get().n, 1);
    read.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
