import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertAuditedBuild } from './cacbg/build-proof.mjs';

/** One declarant, one declaration, no links — enough to drive every stage of the offline job. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sigma-job-'));
  const paths = {
    dir,
    source: join(dir, 'source.sqlite'),
    raw: join(dir, 'raw'),
    staging: join(dir, 'staging'),
    work: join(dir, 'work'),
  };
  const db = new DatabaseSync(paths.source);
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  db.close();
  mkdirSync(join(paths.raw, '2025'), { recursive: true });
  writeFileSync(join(paths.raw, '.corpus-complete.json'), '{}');
  writeFileSync(
    join(paths.raw, '2025/list.xml'),
    '<root><MainCategory><Category Name="Годишни"><Institution Name="Тест"><Person><Name>Иван Петров Тестов</Name><Position><Name>Директор</Name><Declaration><xmlFile>a.xml</xmlFile></Declaration></Position></Person></Institution></Category></MainCategory></root>',
  );
  writeFileSync(
    join(paths.raw, '2025/a.xml'),
    '<PublicPerson><Personal><Name>Иван Петров Тестов</Name><Work>Тест</Work></Personal><DeclarationData><Year>2025</Year><ControlHash>test</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData><Tables/></PublicPerson>',
  );
  return paths;
}

const runJob = ({ source, raw, staging, work }, extra = []) =>
  String(
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
        ...extra,
      ],
      {
        env: { ...process.env, CACBG_RAW: raw, CACBG_STAGING: staging },
        stdio: 'pipe',
        timeout: 60000,
      },
    ),
  );

test('the offline job builds, audits and emits a complete empty-link corpus; modified DB cannot ship', async () => {
  const paths = fixture();
  try {
    runJob(paths);
    const built = join(paths.work, 'backfill.sqlite');
    await assertAuditedBuild(built);
    assert.ok(readdirSync(join(paths.work, 'ship')).some((f) => f.endsWith('_publish.sql')));
    const changed = new DatabaseSync(built);
    changed.exec("INSERT INTO persons(id,name) VALUES('test-mutation','changed')");
    changed.close();
    await assert.rejects(() => assertAuditedBuild(built), /not the audited/);
  } catch (error) {
    if (error.stderr) console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// The rebuild reads the register between the two halves, so the job has to stop where the declarations
// have named their companies and pick up again without redoing the snapshot or the extraction.
test('the job stops after the candidates and finishes from decide, carrying no receipt in between', async () => {
  const paths = fixture();
  try {
    const paused = runJob(paths, ['--until', 'candidates']);
    assert.match(paused, /"event":"declarations_job_paused"/);
    assert.doesNotMatch(paused, /declarations_job_complete/);
    assert.ok(!existsSync(join(paths.work, 'ship')), 'a half-run must not emit a publication');
    const built = join(paths.work, 'backfill.sqlite');
    assert.ok(existsSync(built), 'the snapshot of the first half stays for the second');
    const before = readFileSync(built);

    const done = runJob(paths, ['--from', 'decide']);
    assert.match(done, /"event":"declarations_job_complete"/);
    await assertAuditedBuild(built);
    assert.ok(readdirSync(join(paths.work, 'ship')).some((f) => f.endsWith('_publish.sql')));
    assert.notDeepEqual(before, readFileSync(built), 'the second half decides and loads');
  } catch (error) {
    if (error.stderr) console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// Between the halves the rebuild's catch-up pass reads the requested companies into the work database and
// accepts the register's baseline there. The second half goes on in that database: copying the source in
// again would drop the partidas it read and leave the baseline open.
test('the second half keeps what was written between the halves, and needs the first half', async () => {
  const paths = fixture();
  try {
    runJob(paths, ['--until', 'candidates']);
    const built = join(paths.work, 'backfill.sqlite');
    const between = new DatabaseSync(built);
    between.exec(`INSERT INTO registry_deeds (eik, name, outcome, fetched_at)
        VALUES ('000000019', 'ТЕСТ ГРУП ЕООД', 'ok', '2026-11-20T00:00:00Z');
      INSERT INTO registry_entry_state (id, seeded_through, baseline_status)
        VALUES (1, '2026-11-20', 'ready');`);
    between.close();

    runJob(paths, ['--from', 'decide']);
    const done = new DatabaseSync(built, { readOnly: true });
    try {
      assert.equal(done.prepare('SELECT COUNT(*) n FROM registry_deeds').get().n, 1);
      assert.equal(
        done.prepare('SELECT baseline_status FROM registry_entry_state').get()?.baseline_status,
        'ready',
      );
    } finally {
      done.close();
    }

    rmSync(paths.work, { recursive: true, force: true });
    assert.throws(
      () => runJob(paths, ['--from', 'decide']),
      (error) => /work database of the first half/.test(String(error.stderr)),
    );
  } catch (error) {
    if (error.stderr) console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
