import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { digest } from './corpus.mjs';
import { STREAMS, headKey } from './extract-checkpoint.mjs';

// One temp staging dir for the whole file: extract.mjs reads its paths when the module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-extract-resume-'));
const staging = path.join(dir, 'staging');
process.env.CACBG_RAW = path.join(dir, 'raw');
process.env.CACBG_STAGING = staging;
delete process.env.CACBG_REGISTRY_DB;
const { run } = await import('./extract.mjs');

const FOLDERS = ['2024', '2025', '2026'];
const person = (n) => `Иван Петров Тест${n}`;
const xml = (name, hash) =>
  `<PublicPerson><Personal><Name>${name}</Name><Work>Тест институция</Work><Position>Директор</Position></Personal>` +
  `<DeclarationData><Year>2025</Year><ControlHash>${hash}</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData>` +
  `<Tables><Table Num="10" Declared="True" Description="Дялове в дружества с ограничена отговорност">` +
  `<Row><Cell Num="4" Description="Наименование на дружеството">„Алфа“ ООД</Cell>` +
  `<Cell Num="7" Description="Име собствено бащино фамилно">${name}</Cell></Row></Table></Tables></PublicPerson>`;

/** An in-memory corpus in the remote shape: stamped inventory, per-folder index, checksummed files. */
function corpus() {
  const objects = new Map();
  const inventory = [];
  for (const folder of FOLDERS) {
    const docs = [1, 2].map((n) => [`d${n}.xml`, person(`${folder}-${n}`)]);
    // The same document body repeats across folders, so the duplicate map is exercised on resume too.
    const files = docs.map(([file, name]) => {
      const body = Buffer.from(xml(name, 'HASH1'));
      objects.set(`${folder}/${file}`, body);
      return { file, sha256: digest(body) };
    });
    const list = Buffer.from(
      `<root><MainCategory><Category Name="Годишни"><Institution Name="Тест институция">${docs
        .map(
          ([file, name]) =>
            `<Person><Name>${name}</Name><Position><Name>Директор</Name><Declaration><xmlFile>${file}</xmlFile></Declaration></Position></Person>`,
        )
        .join('')}</Institution></Category></MainCategory></root>`,
    );
    objects.set(`${folder}/list.xml`, list);
    const index = Buffer.from(JSON.stringify({ listHash: digest(list), files, missing: [] }));
    objects.set(`${folder}/.index.json`, index);
    inventory.push({ folder, sha256: digest(index) });
  }
  objects.set(
    '.corpus-complete.json',
    Buffer.from(JSON.stringify({ schemaVersion: 3, inventory, incomplete: false })),
  );
  return {
    objects,
    store: {
      remote: true,
      get: async (key) => objects.get(key) ?? null,
      put: async (key, body) => {
        objects.set(key, Buffer.from(body));
      },
    },
  };
}

const outputs = () =>
  Object.fromEntries(
    STREAMS.map((stream) => [stream, fs.readFileSync(path.join(staging, `${stream}.jsonl`))]),
  );
const manifest = () => {
  const { extractedAt, ...rest } = JSON.parse(
    fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'),
  );
  return rest;
};
const clearStaging = () => fs.rmSync(staging, { recursive: true, force: true });

test('an extract interrupted at any folder resumes into byte-identical output', async () => {
  const { store } = corpus();
  delete process.env.SIGMA_RUN_ID;
  assert.equal(await run({ store }), 0);
  const golden = outputs();
  const goldenManifest = manifest();
  assert.ok(golden.filings.length > 0);

  for (let cut = 1; cut <= FOLDERS.length - 1; cut++) {
    clearStaging();
    const fresh = corpus();
    process.env.SIGMA_RUN_ID = `00000000-0000-4000-8000-00000000000${cut}`;
    assert.equal(await run({ store: fresh.store, yieldAfterFolders: cut }), 75);
    // A yield leaves no completion marker and an accepted head naming exactly the read folders.
    assert.equal(fs.existsSync(path.join(staging, 'manifest.json')), false);
    const head = JSON.parse(fresh.objects.get(headKey(process.env.SIGMA_RUN_ID)).toString('utf8'));
    assert.deepEqual(head.folders, FOLDERS.slice(0, cut));

    assert.equal(await run({ store: fresh.store }), 0);
    assert.deepEqual(outputs(), golden);
    assert.deepEqual(manifest(), goldenManifest);
  }
  delete process.env.SIGMA_RUN_ID;
  clearStaging();
});

test('a checkpoint from other inputs is ignored, and a missing part refuses the whole head', async () => {
  clearStaging();
  const first = corpus();
  process.env.SIGMA_RUN_ID = '00000000-0000-4000-8000-0000000000ff';
  assert.equal(await run({ store: first.store, yieldAfterFolders: 1 }), 75);
  const head = headKey(process.env.SIGMA_RUN_ID);
  const accepted = first.objects.get(head);

  // Same run id, a corpus whose inventory changed: the head no longer describes these inputs.
  clearStaging();
  const other = corpus();
  other.objects.set('2024/d1.xml', Buffer.from(xml(person('changed'), 'HASH2')));
  const index = JSON.parse(other.objects.get('2024/.index.json').toString('utf8'));
  index.files[0].sha256 = digest(other.objects.get('2024/d1.xml'));
  other.objects.set('2024/.index.json', Buffer.from(JSON.stringify(index)));
  const stamp = JSON.parse(other.objects.get('.corpus-complete.json').toString('utf8'));
  stamp.inventory[0].sha256 = digest(other.objects.get('2024/.index.json'));
  other.objects.set('.corpus-complete.json', Buffer.from(JSON.stringify(stamp)));
  delete process.env.SIGMA_RUN_ID;
  assert.equal(await run({ store: other.store }), 0);
  const changedGolden = outputs();
  // Now the same changed corpus, but carrying the head of the previous inputs: it must be ignored.
  clearStaging();
  process.env.SIGMA_RUN_ID = '00000000-0000-4000-8000-0000000000ff';
  other.objects.set(head, accepted);
  assert.equal(await run({ store: other.store }), 0);
  assert.deepEqual(outputs(), changedGolden);

  // The head is for these inputs, but a part is gone: refuse rather than resume half a folder.
  clearStaging();
  const third = corpus();
  process.env.SIGMA_RUN_ID = '00000000-0000-4000-8000-0000000000fe';
  assert.equal(await run({ store: third.store, yieldAfterFolders: 1 }), 75);
  for (const key of [...third.objects.keys()])
    if (key.includes('/2024/')) third.objects.delete(key);
  await assert.rejects(run({ store: third.store }), /Checkpoint part missing/);
  delete process.env.SIGMA_RUN_ID;
  fs.rmSync(dir, { recursive: true, force: true });
});
