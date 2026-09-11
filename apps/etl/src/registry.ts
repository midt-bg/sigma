// The registry layer's D1 side (ADR-0041): which partidas still need reading, the run's lease, and writing one
// partida's facts. The register itself is read through @sigma/ingest's client; nothing here touches the net.
import type { DeedLookup, RegistryPerson, RegistryRole } from '@sigma/ingest';
import { rolesFromDeed } from '@sigma/ingest';

export const REGISTRY_LEASE_TTL_MS = 30 * 60 * 1000;

/** One writer at a time, like the refresh: the lease expires, so a hung run cannot fence the cron out. */
export async function acquireRegistryLease(
  db: D1Database,
  holder: string,
  now: Date = new Date(),
  ttlMs: number = REGISTRY_LEASE_TTL_MS,
): Promise<boolean> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO registry_sync (id, holder, expires_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET holder = ?1, expires_at = ?2
       WHERE registry_sync.holder IS NULL OR registry_sync.holder = ?1 OR registry_sync.expires_at <= ?3`,
    )
    .bind(holder, new Date(now.getTime() + ttlMs).toISOString(), at)
    .run();
  return (await leaseHolder(db)) === holder;
}

/** Renew — and so re-check — the lease before a step that writes; false once someone else holds it. */
export async function renewRegistryLease(
  db: D1Database,
  holder: string,
  now: Date = new Date(),
  ttlMs: number = REGISTRY_LEASE_TTL_MS,
): Promise<boolean> {
  await db
    .prepare('UPDATE registry_sync SET expires_at = ?2 WHERE id = 1 AND holder = ?1')
    .bind(holder, new Date(now.getTime() + ttlMs).toISOString())
    .run();
  return (await leaseHolder(db)) === holder;
}

/** Release only what we hold; how far the changes were followed stays. */
export async function releaseRegistryLease(db: D1Database, holder: string): Promise<void> {
  await db
    .prepare(
      'UPDATE registry_sync SET holder = NULL, expires_at = NULL WHERE id = 1 AND holder = ?',
    )
    .bind(holder)
    .run();
}

async function leaseHolder(db: D1Database): Promise<string | null> {
  const r = await db
    .prepare('SELECT holder FROM registry_sync WHERE id = 1')
    .first<{ holder: string | null }>();
  return r?.holder ?? null;
}

/** The last load day of the API whose changes have been queued, or null before the first. */
export async function registryChangesThrough(db: D1Database): Promise<string | null> {
  const r = await db
    .prepare('SELECT changes_through FROM registry_sync WHERE id = 1')
    .first<{ changes_through: string | null }>();
  return r?.changes_through ?? null;
}

export async function setRegistryChangesThrough(db: D1Database, day: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO registry_sync (id, changes_through) VALUES (1, ?1)
       ON CONFLICT(id) DO UPDATE SET changes_through = ?1`,
    )
    .bind(day)
    .run();
}

const queued = async (db: D1Database) =>
  (await db.prepare('SELECT COUNT(*) AS n FROM registry_queue').first<{ n: number }>())?.n ?? 0;

/** Queue the winners never read: companies with a partida ЕИК and at least one contract. */
export async function queueNewWinners(db: D1Database, now: string, limit: number): Promise<number> {
  const before = await queued(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO registry_queue (eik, reason, queued_at)
       SELECT DISTINCT b.eik_normalized, 'new', ?1 FROM bidders b
       WHERE b.eik_valid = 1 AND length(b.eik_normalized) = 9
         AND EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik = b.eik_normalized)
       LIMIT ?2`,
    )
    .bind(now, limit)
    .run();
  return (await queued(db)) - before;
}

/** Queue again the read partidas the register changed; one it never read is the new-winner queue's job. */
export async function queueChanged(db: D1Database, uics: string[], now: string): Promise<number> {
  if (uics.length === 0) return 0;
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM registry_deeds WHERE eik IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(uics))
    .first<{ n: number }>();
  await db
    .prepare(
      `INSERT INTO registry_queue (eik, reason, queued_at)
       SELECT d.eik, 'changed', ?2 FROM registry_deeds d WHERE d.eik IN (SELECT value FROM json_each(?1))
       ON CONFLICT(eik) DO UPDATE SET reason = 'changed', queued_at = excluded.queued_at`,
    )
    .bind(JSON.stringify(uics), now)
    .run();
  return r?.n ?? 0;
}

/** Queue every read partida again — the fallback when the changes feed was left too far behind to follow.
 *  (`WHERE true`: without a WHERE, SQLite reads the upsert's ON as a join constraint of the SELECT.) */
export async function queueAllRead(db: D1Database, now: string): Promise<number> {
  await db
    .prepare(
      `INSERT INTO registry_queue (eik, reason, queued_at) SELECT eik, 'changed', ?1 FROM registry_deeds WHERE true
       ON CONFLICT(eik) DO UPDATE SET reason = 'changed', queued_at = excluded.queued_at`,
    )
    .bind(now)
    .run();
  return queued(db);
}

/** The next partidas to read: changed ones first (they are stale on the site), then new, oldest first. */
export async function nextQueued(db: D1Database, limit: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT eik FROM registry_queue ORDER BY (reason = 'changed') DESC, queued_at, eik LIMIT ?`,
    )
    .bind(limit)
    .all<{ eik: string }>();
  return rows.results.map((r) => r.eik);
}

const ROLE_INSERT = `INSERT INTO registry_roles (eik, field_ident, record_id, role, subject_kind, subject_id,
  subject_name, share, country, entry_number, added_on, removed_on) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT(eik, field_ident, record_id, subject_id) DO UPDATE SET role = excluded.role,
  subject_kind = excluded.subject_kind, subject_name = excluded.subject_name, share = excluded.share,
  country = excluded.country, entry_number = excluded.entry_number, added_on = excluded.added_on,
  removed_on = excluded.removed_on`;
const PERSON_UPSERT = `INSERT INTO registry_persons (indent, name, indent_type) VALUES (?1, ?2, ?3)
  ON CONFLICT(indent) DO UPDATE SET name = excluded.name, indent_type = excluded.indent_type`;
const DEED_UPSERT = `INSERT INTO registry_deeds (eik, name, legal_form, status, outcome, fetched_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(eik) DO UPDATE SET name = excluded.name,
  legal_form = excluded.legal_form, status = excluded.status, outcome = excluded.outcome, fetched_at = excluded.fetched_at`;

/** Replace one partida's facts with what the register says now, in one batch, and take it off the queue. */
export async function storeDeed(
  db: D1Database,
  eik: string,
  lookup: DeedLookup,
  fetchedAt: string,
): Promise<{ roles: number; persons: number }> {
  let roles: RegistryRole[] = [];
  let persons: RegistryPerson[] = [];
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM registry_roles WHERE eik = ?').bind(eik),
  ];
  if (lookup.status === 'ok') {
    ({ roles, persons } = rolesFromDeed(eik, lookup.deed));
    const d = lookup.deed.deed;
    statements.push(
      db.prepare(DEED_UPSERT).bind(eik, d.name, d.legalForm, d.status, 'ok', fetchedAt),
    );
    for (const p of persons)
      statements.push(db.prepare(PERSON_UPSERT).bind(p.indent, p.name, p.indentType));
    for (const r of roles)
      statements.push(
        db
          .prepare(ROLE_INSERT)
          .bind(
            r.eik,
            r.fieldIdent,
            r.recordId,
            r.role,
            r.subjectKind,
            r.subjectId,
            r.subjectName,
            r.share,
            r.country,
            r.entryNumber,
            r.addedOn,
            r.removedOn,
          ),
      );
  } else {
    statements.push(db.prepare(DEED_UPSERT).bind(eik, null, null, null, 'absent', fetchedAt));
  }
  statements.push(db.prepare('DELETE FROM registry_queue WHERE eik = ?').bind(eik));
  await db.batch(statements);
  return { roles: roles.length, persons: persons.length };
}
