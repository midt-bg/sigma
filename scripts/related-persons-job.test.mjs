import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertAuditedBuild } from './cacbg/build-proof.mjs';
test('the offline job builds, audits and emits a complete empty-link corpus; modified DB cannot ship', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-job-'));
  const source = join(dir, 'source.sqlite'),
    raw = join(dir, 'raw'),
    staging = join(dir, 'staging'),
    work = join(dir, 'work');
  const db = new DatabaseSync(source);
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.close();
  mkdirSync(join(raw, '2025'), { recursive: true });
  writeFileSync(join(raw, '.corpus-complete.json'), '{}');
  writeFileSync(
    join(raw, '2025/list.xml'),
    '<root><MainCategory><Category Name="Годишни"><Institution Name="Тест"><Person><Name>Иван Петров Тестов</Name><Position><Name>Директор</Name><Declaration><xmlFile>a.xml</xmlFile></Declaration></Position></Person></Institution></Category></MainCategory></root>',
  );
  writeFileSync(
    join(raw, '2025/a.xml'),
    '<PublicPerson><Personal><Name>Иван Петров Тестов</Name><Work>Тест</Work></Personal><DeclarationData><Year>2025</Year><ControlHash>test</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData><Tables/></PublicPerson>',
  );
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        './scripts/cacbg/register-ts.mjs',
        'scripts/related-persons-job.mjs',
        '--source-db',
        source,
        '--work-dir',
        work,
        '--skip-fetch',
      ],
      {
        env: { ...process.env, CACBG_RAW: raw, CACBG_STAGING: staging },
        stdio: 'pipe',
        timeout: 60000,
      },
    );
    const built = join(work, 'backfill.sqlite');
    await assertAuditedBuild(built);
    assert.ok(readdirSync(join(work, 'ship')).some((f) => f.endsWith('_publish.sql')));
    const changed = new DatabaseSync(built);
    changed.exec("INSERT INTO persons(id,name) VALUES('test-mutation','changed')");
    changed.close();
    await assert.rejects(() => assertAuditedBuild(built), /not the audited/);
  } catch (error) {
    if (error.stderr) console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
