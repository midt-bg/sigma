import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('company requests use the full official name independently of winners and retain source provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-request-'));
  try {
    const catalog = join(dir, 'catalog.sqlite'),
      dbFile = join(dir, 'work.sqlite');
    const cat = new DatabaseSync(catalog);
    cat.exec(
      `CREATE TABLE companies(eik,name,legal_form); INSERT INTO companies VALUES('123456789','ГД ТЕСТ','OOD'),('987654321','ТЕСТ','OOD');`,
    );
    cat.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`CREATE TABLE interest_links(person_id,status);CREATE TABLE declarations(person_id,folder_year,xml_file);
  INSERT INTO interest_links VALUES('person:identity:verified','published');
  INSERT INTO declarations VALUES('person:identity:verified','2025','a.xml');`);
    db.close();
    writeFileSync(
      join(dir, 'holdings.jsonl'),
      JSON.stringify({
        folder: '2025',
        xmlFile: 'a.xml',
        person: 'Иван Петров Тестов',
        institution: 'Община Тест',
        entity: 'ГД "ТЕСТ" ООД',
      }) + '\n',
    );
    writeFileSync(
      join(dir, 'registry-requests.jsonl'),
      JSON.stringify({
        eik: '222222222',
        declarationId: 'decl:2025:b.xml',
        declaredName: 'Изрично посочен ЕИК',
      }) + '\n',
    );
    execFileSync(
      process.execPath,
      [
        '--import',
        './scripts/cacbg/register-ts.mjs',
        'scripts/cacbg/request-companies.mjs',
        '--catalog',
        catalog,
        '--db',
        dbFile,
        '--staging',
        dir,
      ],
      { stdio: 'pipe' },
    );
    const requests = readFileSync(join(dir, 'registry-requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(requests.map((r) => r.eik).sort(), ['123456789', '222222222']);
    assert.equal(requests.find((r) => r.eik === '123456789').declarationId, 'decl:2025:a.xml');
    assert.equal(readFileSync(join(dir, 'identity-eiks.txt'), 'utf8').trim(), '123456789');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
