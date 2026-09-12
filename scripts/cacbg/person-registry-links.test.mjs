import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildPersonRegistryLinks } from './person-registry-links.mjs';

test('requires a unique same-company, same-entry, full-name self claim; never maps family or namesakes', () => {
  const db = new DatabaseSync(':memory:');
  const registry = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id TEXT PRIMARY KEY,name);CREATE TABLE declarations(id TEXT PRIMARY KEY);
  CREATE TABLE interest_links(person_id,eik,link_key,status,interest_class,relation);
  CREATE TABLE interest_link_evidence(link_key,entry_number,evidence_kind);
  INSERT INTO persons VALUES('self','Иван Петров Иванов'),('family','Петя Петрова Иванова'),('ambiguous','Георги Петров Георгиев');
  INSERT INTO interest_links VALUES('self','1','l1','published','private_ownership','owns'),('family','2','l2','published','family_ownership','related'),('ambiguous','3','l3','published','private_ownership','owns');
  INSERT INTO interest_link_evidence VALUES('l1','entry1','document'),('l2','entry2','document'),('l3','entry3','document');`);
    registry.exec(
      'CREATE TABLE registry_roles(eik,entry_number,subject_kind,role,subject_id,subject_name)',
    );
    const put = registry.prepare("INSERT INTO registry_roles VALUES(?,?,'person','partner',?,?)");
    put.run('1', 'entry1', 'a'.repeat(64), 'ИВАН ПЕТРОВ ИВАНОВ');
    put.run('2', 'entry2', 'b'.repeat(64), 'ПЕТЯ ПЕТРОВА ИВАНОВА');
    put.run('3', 'entry3', 'c'.repeat(64), 'ГЕОРГИ ПЕТРОВ ГЕОРГИЕВ');
    put.run('3', 'entry3', 'd'.repeat(64), 'ГЕОРГИ ПЕТРОВ ГЕОРГИЕВ');
    assert.deepEqual(buildPersonRegistryLinks(db, registry, '2026-09-12'), {
      examined: 2,
      linked: 1,
      ambiguous: 1,
    });
    assert.equal(db.prepare('SELECT person_id FROM person_registry_links').get().person_id, 'self');
  } finally {
    db.close();
    registry.close();
  }
});

test('rechecks a source alias across its proven same-Indent company entries, even without a published interest', () => {
  const db = new DatabaseSync(':memory:'),
    registry = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id TEXT PRIMARY KEY,name); CREATE TABLE declarations(id TEXT PRIMARY KEY,person_id);
      CREATE TABLE interest_links(person_id,eik,link_key,status,interest_class,relation);
      CREATE TABLE interest_link_evidence(link_key,entry_number,evidence_kind);
      CREATE TABLE declaration_identity_evidence(declaration_id,registry_indent,eik,entry_number,document_name,listed_names,rule_version);
      INSERT INTO persons VALUES('p','Ивана Петрова Тестова');INSERT INTO declarations VALUES('doc','p');`);
    registry.exec(
      'CREATE TABLE registry_roles(eik,entry_number,subject_kind,role,subject_id,subject_name)',
    );
    const put = registry.prepare(
      "INSERT INTO registry_roles VALUES(?,'entry','person','partner',?,?)",
    );
    const id = 'a'.repeat(64),
      name = 'Ивана Петрова Тестова',
      alias = 'Ивана Петрова Тестова-Примерова';
    put.run('1', id, name);
    put.run('1', id, alias);
    put.run('2', id, name);
    const proof = db.prepare(
      "INSERT INTO declaration_identity_evidence VALUES('doc',?,?,'entry',?,?,'registry-identity-1')",
    );
    for (const eik of ['1', '2']) proof.run(id, eik, name, JSON.stringify([alias]));
    assert.equal(buildPersonRegistryLinks(db, registry).linked, 1);
    registry
      .prepare('UPDATE registry_roles SET subject_id=? WHERE subject_name=?')
      .run('b'.repeat(64), alias);
    assert.throws(() => buildPersonRegistryLinks(db, registry), /Unproven listing alias/);
  } finally {
    db.close();
    registry.close();
  }
});
