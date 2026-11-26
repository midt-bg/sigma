// An invented declarations corpus in the shape the container reads from R2: a stamped inventory, a
// per-folder index with content hashes, checksummed files. Test-only; every name and number is made up.
import { digest } from './corpus.mjs';

export const declaration = (name, { hash = 'HASH1', company = '„Алфа“ ООД', holder = name } = {}) =>
  `<PublicPerson><Personal><Name>${name}</Name><Work>Община Тест</Work><Position>Директор</Position></Personal>` +
  `<DeclarationData><Year>2025</Year><ControlHash>${hash}</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData>` +
  `<Tables><Table Num="10" Declared="True" Description="Дялове в дружества с ограничена отговорност">` +
  `<Row><Cell Num="4" Description="Наименование на дружеството">${company}</Cell>` +
  `<Cell Num="7" Description="Име собствено бащино фамилно">${holder}</Cell></Row></Table></Tables></PublicPerson>`;

/** A list.xml announcing `rows` ([file, listed name, person]); rows with the same person (a number) are
 *  one <Person> with several declarations, every other row a person of its own. */
export const listing = (rows) => {
  const people = new Map();
  rows.forEach(([file, name, person = `row${people.size}`]) => {
    const entry = people.get(person) ?? { name, files: [] };
    entry.files.push(file);
    people.set(person, entry);
  });
  return `<root><MainCategory><Category Name="Годишни"><Institution Name="Община Тест">${[
    ...people.values(),
  ]
    .map(
      ({ name, files }) =>
        `<Person><Name>${name}</Name><Position><Name>Директор</Name>${files
          .map((file) => `<Declaration><xmlFile>${file}</xmlFile></Declaration>`)
          .join('')}</Position></Person>`,
    )
    .join('')}</Institution></Category></MainCategory></root>`;
};

/**
 * `folders`: { [folder]: [{ file, name, body?, sourceFolder?, person? }] } — `name` is the listed name,
 * `body` the file's text (a declaration of `name` when absent), `sourceFolder` a sibling folder the file
 * lives in, `person` the listing's person when several files share one. Returns the objects map and a
 * remote store over it; `setFolder` and `removeFolder` edit a folder and re-seal the inventory.
 */
export function memoryCorpus(folders) {
  const objects = new Map();
  const corpus = {
    objects,
    reads: [],
    setFolder(folder, docs) {
      const files = docs.map(({ file, name, body, sourceFolder }) => {
        const bytes = Buffer.from(body ?? declaration(name));
        objects.set(`${sourceFolder ?? folder}/${file}`, bytes);
        return { file, sha256: digest(bytes), ...(sourceFolder ? { sourceFolder } : {}) };
      });
      files.sort((a, b) => a.file.localeCompare(b.file));
      const list = Buffer.from(listing(docs.map(({ file, name, person }) => [file, name, person])));
      objects.set(`${folder}/list.xml`, list);
      objects.set(
        `${folder}/.index.json`,
        Buffer.from(JSON.stringify({ listHash: digest(list), files, missing: [], failed: [] })),
      );
      corpus.stamp();
    },
    removeFolder(folder) {
      for (const key of [...objects.keys()]) if (key.startsWith(`${folder}/`)) objects.delete(key);
      corpus.stamp();
    },
    stamp() {
      const inventory = [...objects.keys()]
        .filter((key) => key.endsWith('/.index.json'))
        .map((key) => key.split('/')[0])
        .sort()
        .map((folder) => ({ folder, sha256: digest(objects.get(`${folder}/.index.json`)) }));
      objects.set(
        '.corpus-complete.json',
        Buffer.from(JSON.stringify({ schemaVersion: 3, inventory, incomplete: false })),
      );
    },
    store: {
      remote: true,
      async get(key) {
        corpus.reads.push(key);
        return objects.get(key) ?? null;
      },
      async put(key, body) {
        objects.set(key, Buffer.from(body));
      },
    },
  };
  for (const [folder, docs] of Object.entries(folders)) corpus.setFolder(folder, docs);
  return corpus;
}
