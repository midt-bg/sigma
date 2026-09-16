import { execFileSync } from 'node:child_process';

// D1 exports have no transaction. One fsync per INSERT makes a large restore take hours.
// sqlite reads the file itself, without buffering the entire export in Node's memory.
export function importSql(db, sql) {
  if (/[\r\n\0]/.test(sql)) throw Error('Invalid SQL input path');
  execFileSync('sqlite3', ['-bail', db, 'BEGIN;', `.read ${JSON.stringify(sql)}`, 'COMMIT;'], {
    stdio: 'inherit',
  });
}
