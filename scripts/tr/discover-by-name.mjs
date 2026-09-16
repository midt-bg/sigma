// Local discovery of partidas by name, for people the register already identifies: every name a person
// filed declarations under, and the register's own spelling, is searched; the hits are kept in the work
// database and the partidas not read yet are listed for tr/refresh-identity.mjs. Roles are attributed
// later by the person's identifier alone, never by the name that found the partida.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { registryClient } from '../../packages/ingest/src/registry.ts';
import { declarantNameKey } from '../cacbg/source-identity.mjs';
import { assertOverrideDirSafe } from '../cacbg/guard.mjs';

// A name naming more partidas than this belongs to too many people to be worth reading them all.
export const MAX_HITS = 100;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS registry_name_searches(
  indent TEXT NOT NULL, name TEXT NOT NULL, total INTEGER NOT NULL, searched_at TEXT NOT NULL,
  PRIMARY KEY(indent, name));
CREATE TABLE IF NOT EXISTS registry_name_hits(
  indent TEXT NOT NULL, name TEXT NOT NULL, eik TEXT NOT NULL, company_name TEXT NOT NULL,
  field_ident TEXT NOT NULL, holder_name TEXT NOT NULL,
  PRIMARY KEY(indent, name, eik, field_ident, holder_name));`;

/** (indent, name) pairs still to search: declared names and the register's spelling, one per name key,
 * in the key's own spelling (upper case, single spaces) — the search ignores case. `scope` 'linked'
 * takes only people with a published interest link; 'all' takes everyone the register identifies. */
export function pendingSearches(db, limit = Infinity, scope = 'linked') {
  const linked =
    scope === 'linked'
      ? " AND EXISTS(SELECT 1 FROM interest_links il WHERE il.person_id=e.id AND il.status='published')"
      : '';
  const rows = db
    .prepare(
      `SELECT e.registry_indent indent, s.name FROM person_entities e
       JOIN person_sources s ON s.entity_id=e.id AND s.active=1 AND s.namespace='cacbg'
       WHERE e.registry_indent IS NOT NULL${linked}
       UNION ALL
       SELECT e.registry_indent, p.name FROM person_entities e
       JOIN registry_persons p ON p.indent=e.registry_indent
       WHERE 1${linked}
       ORDER BY 1, 2`,
    )
    .all();
  const done = new Set(
    db
      .prepare('SELECT indent, name FROM registry_name_searches')
      .all()
      .map((r) => `${r.indent}|${declarantNameKey(r.name)}`),
  );
  const out = [];
  for (const r of rows) {
    const key = declarantNameKey(r.name);
    if (key.split(' ').length < 2 || done.has(`${r.indent}|${key}`)) continue;
    done.add(`${r.indent}|${key}`);
    out.push({ indent: r.indent, name: key });
  }
  return out
    .sort((a, b) => a.indent.localeCompare(b.indent) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Search one name and record the outcome; a too-common name records its total and no hits. */
export async function discover(db, client, { indent, name }, now = new Date().toISOString()) {
  const hits = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const result = await client.holdersNamed(name, page);
    total = result.total;
    if (total > MAX_HITS) break;
    hits.push(...result.items);
    if (!result.hasMore) break;
  }
  const insert = db.prepare('INSERT OR IGNORE INTO registry_name_hits VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    if (total <= MAX_HITS)
      for (const h of hits) insert.run(indent, name, h.uic, h.companyName, h.fieldIdent, h.name);
    db.prepare('INSERT OR REPLACE INTO registry_name_searches VALUES(?,?,?,?)').run(
      indent,
      name,
      total,
      now,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { total, recorded: total <= MAX_HITS ? hits.length : 0 };
}

/** Partidas the hits name that the work database has not read yet. */
export function unreadPartidas(db) {
  return db
    .prepare(
      `SELECT DISTINCT h.eik FROM registry_name_hits h
       WHERE NOT EXISTS(SELECT 1 FROM registry_deeds d WHERE d.eik=h.eik) ORDER BY h.eik`,
    )
    .all()
    .map((r) => r.eik);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
  if (!process.argv.includes('--db')) throw new Error('--db required');
  const file = path.resolve(arg('--db'));
  assertOverrideDirSafe(path.dirname(file), '--db');
  const limit = process.argv.includes('--limit') ? Number(arg('--limit')) : Infinity;
  const pace = process.argv.includes('--pace') ? Number(arg('--pace')) : 250;
  const scope = process.argv.includes('--scope') ? arg('--scope') : 'linked';
  if (!['linked', 'all'].includes(scope)) throw new Error('--scope linked|all');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const client = registryClient({ baseUrl: 'https://api-sigma-cr.registryagency.bg' });
  const pending = pendingSearches(db, limit, scope);
  let searched = 0,
    ambiguous = 0,
    failed = 0;
  try {
    for (const item of pending) {
      let done = false;
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        try {
          const r = await discover(db, client, item);
          if (r.total > MAX_HITS) ambiguous++;
          done = true;
          searched++;
        } catch (e) {
          if (attempt === 3) {
            failed++;
            console.error(JSON.stringify({ indent: item.indent, error: String(e) }));
          } else await pause(e.retryMs ?? 30_000);
        }
      }
      if (searched % 50 === 0)
        console.log(JSON.stringify({ searched, ambiguous, failed, total: pending.length }));
      await pause(pace);
    }
    const unread = unreadPartidas(db);
    if (process.argv.includes('--out')) fs.writeFileSync(arg('--out'), unread.join('\n') + '\n');
    console.log(
      JSON.stringify({ searched, ambiguous, failed, total: pending.length, unread: unread.length }),
    );
    if (failed) process.exitCode = 1;
  } finally {
    db.close();
  }
}
