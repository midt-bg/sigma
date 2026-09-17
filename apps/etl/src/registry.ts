// The registry layer's D1 side (ADR-0041): which partidas still need reading, the run's lease, and writing one
// partida's facts. The register itself is read through @sigma/ingest's client; nothing here touches the net.
import type { DeedLookup, RegistryPerson, RegistryRole } from '@sigma/ingest';
import { addDays, companyNamesFromDeed, deedFacts, rolesFromDeed } from '@sigma/ingest';

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

const queued = async (db: D1Database) =>
  (await db.prepare('SELECT COUNT(*) AS n FROM registry_queue').first<{ n: number }>())?.n ?? 0;

/** Every company in scope: winners with a partida ЕИК and a contract, plus the explicitly requested. */
const REQUESTED_COMPANIES = `(
         SELECT DISTINCT b.eik_normalized AS eik FROM bidders b
         WHERE b.eik_valid=1 AND length(b.eik_normalized)=9
           AND EXISTS (SELECT 1 FROM contracts c WHERE c.bidder_id=b.id)
         UNION SELECT eik FROM registry_requested_companies WHERE length(eik)=9
       ) requested`;

/** Queue the winners never read: companies with a partida ЕИК and at least one contract. */
export async function queueNewWinners(db: D1Database, now: string, limit: number): Promise<number> {
  const before = await queued(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO registry_queue (eik, reason, queued_at)
       SELECT eik, 'new', ?1 FROM ${REQUESTED_COMPANIES}
       WHERE (NOT EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik=requested.eik)
         OR (EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik=requested.eik AND d.outcome='ok')
           AND (NOT EXISTS (SELECT 1 FROM registry_identity_snapshots s WHERE s.eik=requested.eik)
             OR NOT EXISTS (SELECT 1 FROM registry_company_history h JOIN registry_identity_snapshots s USING(eik) WHERE h.eik=requested.eik AND h.source_hash=s.source_hash))))
         AND NOT EXISTS (SELECT 1 FROM registry_queue q WHERE q.eik=requested.eik)
       ORDER BY eik LIMIT ?2`,
    )
    .bind(now, limit)
    .run();
  return (await queued(db)) - before;
}

/** The next partidas to read: changed ones first (they are stale on the site), then new, oldest first. */
export async function nextQueued(
  db: D1Database,
  limit: number,
  now = new Date().toISOString(),
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT eik FROM registry_queue WHERE queued_at <= ?2 AND NOT EXISTS (SELECT 1 FROM registry_entry_state WHERE xml_retry_at > ?2) ORDER BY (reason = 'changed') DESC, queued_at, eik LIMIT ?1`,
    )
    .bind(limit, now)
    .all<{ eik: string }>();
  return rows.results.map((r) => r.eik);
}

const ROLE_INSERT = `INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id,
  subject_name, share, country, entry_number, added_on, removed_on, uncertain_after) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  ON CONFLICT(eik, sub_uic, field_ident, subject_id, entry_number) DO UPDATE SET role = excluded.role,
  subject_kind = excluded.subject_kind, subject_name = excluded.subject_name, share = excluded.share,
  country = excluded.country, added_on = excluded.added_on, removed_on = excluded.removed_on, uncertain_after = excluded.uncertain_after`;
const DEED_UPSERT = `INSERT INTO registry_deeds (eik, name, legal_form, status, seat_settlement, seat_entry_on,
  owners_entry_on, outcome, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(eik) DO UPDATE SET
  name = excluded.name, legal_form = excluded.legal_form, status = excluded.status,
  seat_settlement = excluded.seat_settlement, seat_entry_on = excluded.seat_entry_on,
  owners_entry_on = excluded.owners_entry_on, outcome = excluded.outcome, fetched_at = excluded.fetched_at`;

/** Replace one partida's facts with what the register says now, in one batch, and take it off the queue. */
export async function storeDeed(
  db: D1Database,
  eik: string,
  lookup: DeedLookup,
  fetchedAt: string,
): Promise<{ roles: number; persons: number }> {
  const pending = (
    await db
      .prepare('SELECT entry_date FROM registry_entry_signals WHERE eik=? AND confirmed_at IS NULL')
      .bind(eik)
      .all<{ entry_date: string }>()
  ).results;
  const entries =
    lookup.status === 'ok'
      ? lookup.deed.deed.subDeeds.flatMap((s) => s.fields.map((f) => f.entryDate))
      : [];
  // Both published sources use register-local timestamps. Normalize insignificant zero fractions only.
  const dateKey = (date: string) => date.replace(/\.0+$/, '');
  const confirmed = pending.filter((p) =>
    entries.some((d) => dateKey(d) === dateKey(p.entry_date)),
  );
  const existing = await db
    .prepare('SELECT outcome FROM registry_deeds WHERE eik=?')
    .bind(eik)
    .first<{ outcome: string }>();
  const priorDate = await db
    .prepare('SELECT MAX(added_on) AS latest FROM registry_roles WHERE eik=?')
    .bind(eik)
    .first<{ latest: string | null }>();
  const latest = entries.slice().sort().at(-1) ?? '';
  const incomplete =
    confirmed.length < pending.length ||
    (priorDate?.latest && latest < priorDate.latest) ||
    (lookup.status === 'absent' && existing?.outcome === 'ok');
  if (incomplete) {
    // A lagging XML snapshot/404 cannot erase an already accepted fact. Keep unresolved signals forever.
    await deferDeed(db, eik, new Date(Date.parse(fetchedAt) + 6 * 3600000).toISOString());
    return { roles: 0, persons: 0 };
  }
  let roles: RegistryRole[] = [];
  let persons: RegistryPerson[] = [];
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM registry_roles WHERE eik = ?').bind(eik),
    db.prepare('DELETE FROM registry_identity_observations WHERE eik = ?').bind(eik),
    db.prepare('DELETE FROM registry_identity_snapshots WHERE eik = ?').bind(eik),
    db.prepare('DELETE FROM registry_company_history WHERE eik = ?').bind(eik),
  ];
  if (lookup.status === 'ok') {
    const parsed = rolesFromDeed(eik, lookup.deed);
    ({ roles, persons } = parsed);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(lookup.deed.deed)),
    );
    const sourceHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    statements.push(
      db
        .prepare('INSERT INTO registry_identity_snapshots VALUES(?,?,?)')
        .bind(eik, sourceHash, fetchedAt),
      db
        .prepare('INSERT INTO registry_company_history VALUES(?,?,?,?)')
        .bind(eik, JSON.stringify(companyNamesFromDeed(lookup.deed)), sourceHash, fetchedAt),
    );
    for (const o of parsed.observations)
      statements.push(
        db
          .prepare(
            `INSERT INTO registry_identity_observations
      (eik,sub_uic,field_ident,entry_number,entry_on,holder_index,registry_indent,indent_type,name,name_key,subject_kind,source_hash,fetched_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            o.eik,
            o.subUic,
            o.fieldIdent,
            o.entryNumber,
            o.entryOn,
            o.holderIndex,
            o.indent,
            o.indentType,
            o.name,
            o.nameKey,
            o.kind,
            sourceHash,
            fetchedAt,
          ),
      );
    const d = lookup.deed.deed;
    const f = deedFacts(lookup.deed);
    statements.push(
      db
        .prepare(DEED_UPSERT)
        .bind(
          eik,
          d.name,
          d.legalForm,
          d.status,
          f.seatSettlement,
          f.seatEntryOn,
          f.ownersEntryOn,
          'ok',
          fetchedAt,
        ),
    );
    for (const p of persons)
      statements.push(
        db
          .prepare(
            `INSERT INTO registry_persons(indent,name,indent_type)
      SELECT registry_indent,name,indent_type FROM registry_identity_observations
      WHERE registry_indent=? AND subject_kind='person' ORDER BY entry_on DESC,name,eik LIMIT 1
      ON CONFLICT(indent) DO UPDATE SET name=excluded.name,indent_type=excluded.indent_type`,
          )
          .bind(p.indent),
      );
    for (const r of roles)
      statements.push(
        db
          .prepare(ROLE_INSERT)
          .bind(
            r.eik,
            r.subUic,
            r.fieldIdent,
            r.role,
            r.subjectKind,
            r.subjectId,
            r.subjectName,
            r.share,
            r.country,
            r.entryNumber,
            r.addedOn,
            r.removedOn,
            r.uncertainAfter ?? null,
          ),
      );
  } else {
    statements.push(
      db.prepare(DEED_UPSERT).bind(eik, null, null, null, null, null, null, 'absent', fetchedAt),
    );
  }
  for (const p of confirmed)
    statements.push(
      db
        .prepare('UPDATE registry_entry_signals SET confirmed_at=?3 WHERE eik=?1 AND entry_date=?2')
        .bind(eik, p.entry_date, fetchedAt),
    );
  statements.push(db.prepare('DELETE FROM registry_queue WHERE eik = ?').bind(eik));
  await db.batch(statements);
  return { roles: roles.length, persons: persons.length };
}

export const ENTRY_DELAYS = [1, 14] as const;

export type EntryBaseline = 'building' | 'ready' | 'missing-marker';

/**
 * Start a genuinely empty registry as a resumable full import. Existing data without a marker is
 * deliberately not guessed from: an operator must prove its import receipt or rebuild it.
 */
export async function prepareEntryBaseline(
  db: D1Database,
  today: string,
  runId: string,
  now: string,
): Promise<EntryBaseline> {
  const state = await db
    .prepare('SELECT baseline_status FROM registry_entry_state WHERE id=1')
    .first<{ baseline_status: 'unknown' | 'building' | 'ready' }>();
  if (state?.baseline_status === 'ready' || state?.baseline_status === 'building')
    return state.baseline_status;
  const existing = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM registry_deeds) + (SELECT COUNT(*) FROM registry_queue) AS n`,
    )
    .first<{ n: number }>();
  if (state || (existing?.n ?? 0) > 0) return 'missing-marker';
  const through = addDays(today, -1);
  await db
    .prepare(
      `INSERT INTO registry_entry_state
       (id,seeded_through,baseline_status,baseline_through,baseline_started_at,baseline_generation)
       VALUES(1,?1,'building',?1,?2,?3)`,
    )
    .bind(through, now, runId)
    .run();
  return 'building';
}

/** Atomically accept a full import only when every company in scope has a complete local partida. */
export async function completeEntryBaseline(
  db: D1Database,
  runId: string,
  now: string,
): Promise<boolean> {
  await db
    .prepare(
      `UPDATE registry_entry_state
       SET baseline_status='ready',baseline_run_id=?1,baseline_completed_at=?2
       WHERE id=1 AND baseline_status='building'
       AND NOT EXISTS (SELECT 1 FROM registry_queue)
       AND NOT EXISTS (
         SELECT 1 FROM ${REQUESTED_COMPANIES}
         WHERE NOT EXISTS (SELECT 1 FROM registry_deeds d WHERE d.eik=requested.eik)
            OR EXISTS (
              SELECT 1 FROM registry_deeds d WHERE d.eik=requested.eik AND d.outcome='ok'
              AND (NOT EXISTS (SELECT 1 FROM registry_identity_snapshots s WHERE s.eik=requested.eik)
                OR NOT EXISTS (
                  SELECT 1 FROM registry_company_history h
                  JOIN registry_identity_snapshots s USING(eik)
                  WHERE h.eik=requested.eik AND h.source_hash=s.source_hash
                ))
            )
       )`,
    )
    .bind(runId, now)
    .run();
  const state = await db
    .prepare('SELECT baseline_status FROM registry_entry_state WHERE id=1')
    .first<{ baseline_status: string }>();
  return state?.baseline_status === 'ready';
}

/** Seed every closed day after the accepted full-import baseline. */
export async function seedEntryPasses(db: D1Database, today: string, now: string): Promise<void> {
  const state = await db
    .prepare(
      `SELECT seeded_through FROM registry_entry_state
       WHERE id=1 AND baseline_status='ready' AND baseline_through IS NOT NULL`,
    )
    .first<{ seeded_through: string }>();
  if (!state) throw new Error('registry full-import marker is missing');
  for (let day = addDays(state!.seeded_through, 1); day < today; day = addDays(day, 1)) {
    await db.batch([
      ...ENTRY_DELAYS.map((delay) =>
        db
          .prepare(
            'INSERT OR IGNORE INTO registry_entry_passes(day,delay,due_on) VALUES (?1,?2,?3)',
          )
          .bind(day, delay, addDays(day, delay)),
      ),
      db.prepare('UPDATE registry_entry_state SET seeded_through=?1 WHERE id=1').bind(day),
    ]);
  }
}
export interface EntryPass {
  day: string;
  delay: number;
  next_page: number;
  first_count: number | null;
  rows_seen: number;
  last_page_key: string | null;
}
export async function nextEntryPass(
  db: D1Database,
  today: string,
  now: string,
): Promise<EntryPass | null> {
  return db
    .prepare(
      `SELECT p.* FROM registry_entry_passes p, registry_entry_state s
    WHERE s.id=1 AND (s.portal_retry_at IS NULL OR s.portal_retry_at <= ?2)
    AND p.completed_at IS NULL AND p.due_on <= ?1
    ORDER BY (p.next_page > 1) DESC, (p.delay = 1) DESC, p.day, p.delay LIMIT 1`,
    )
    .bind(today, now)
    .first<EntryPass>();
}
export async function deferPortal(db: D1Database, until: string): Promise<void> {
  await db
    .prepare('UPDATE registry_entry_state SET portal_retry_at=?1 WHERE id=1')
    .bind(until)
    .run();
}
export async function recordEntryPage(
  db: D1Database,
  pass: EntryPass,
  page: { items: import('@sigma/ingest').RegistryChange[]; hasMore: boolean; total: number | null },
  now: string,
): Promise<number> {
  const key = JSON.stringify(page.items.map((r) => [r.uic, r.entryDate]));
  if (page.items.length && key === pass.last_page_key)
    throw new Error('portal repeated a page; pass remains incomplete');
  const total = pass.next_page === 1 ? page.total : pass.first_count;
  const seen = pass.rows_seen + page.items.length;
  if (!page.hasMore && total !== null && seen < total) {
    await db
      .prepare(
        'UPDATE registry_entry_passes SET next_page=1, first_count=NULL, rows_seen=0,last_page_key=NULL WHERE day=?1 AND delay=?2',
      )
      .bind(pass.day, pass.delay)
      .run();
    throw new Error('portal ended before its first-page count; restart pass');
  }
  const statements: D1PreparedStatement[] = [];
  for (const item of page.items) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO registry_entry_signals(eik,entry_date,detected_at)
      SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM bidders b JOIN contracts c ON c.bidder_id=b.id WHERE b.eik_normalized=?1 AND b.eik_valid=1)`,
        )
        .bind(item.uic, item.entryDate, now),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO registry_queue(eik,reason,queued_at)
      SELECT ?1,'changed',?3 WHERE EXISTS (SELECT 1 FROM registry_entry_signals WHERE eik=?1 AND entry_date=?2 AND confirmed_at IS NULL)
      ON CONFLICT(eik) DO NOTHING`,
        )
        .bind(item.uic, item.entryDate, now),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE registry_entry_passes SET next_page=?3,first_count=?4,rows_seen=?5,last_page_key=?6,completed_at=?7 WHERE day=?1 AND delay=?2`,
      )
      .bind(pass.day, pass.delay, pass.next_page + 1, total, seen, key, page.hasMore ? null : now),
  );
  await db.batch(statements);
  return page.items.length;
}
export async function deferDeed(db: D1Database, eik: string, until: string): Promise<void> {
  await db.prepare('UPDATE registry_queue SET queued_at=?2 WHERE eik=?1').bind(eik, until).run();
}

/** A Retry-After applies to the XML service, not just the one failed partida. */
export async function deferXml(db: D1Database, until: string): Promise<void> {
  await db
    .prepare(`UPDATE registry_entry_state SET xml_retry_at = ?1 WHERE id = 1`)
    .bind(until)
    .run();
}

/** Public ownership the Trade Register records (ADR-0047), for the refresh to read: a company whose standing
 *  sole owner, or partner with more than half of the partners' capital, is the state, a ministry, a
 *  municipality or a company already public. Municipal when a municipality holds it, directly or through its
 *  companies. The register writes these owners in capitals. */
export const PUBLIC_OWNERSHIP_SQL = [
  `CREATE TABLE IF NOT EXISTS state_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
    canonical_name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal')))`,
  `DELETE FROM public_owned_eik`,
  `INSERT INTO public_owned_eik (eik, ownership_kind)
  WITH RECURSIVE owners AS (
    SELECT r.eik, r.subject_id owner, r.subject_name name, r.role,
      CAST(REPLACE(REPLACE(trim(r.share), ' ', ''), ',', '.') AS REAL) amount
    FROM registry_roles r
    WHERE r.subject_kind = 'entity' AND r.role IN ('sole_owner', 'partner')
      AND r.removed_on IS NULL AND r.uncertain_after IS NULL
  ), capital AS (
    SELECT eik, SUM(CAST(REPLACE(REPLACE(trim(share), ' ', ''), ',', '.') AS REAL)) total
    FROM registry_roles
    WHERE role = 'partner' AND removed_on IS NULL AND uncertain_after IS NULL
    GROUP BY eik
  ), controlled AS (
    SELECT o.eik, o.owner, o.name FROM owners o LEFT JOIN capital c ON c.eik = o.eik
    WHERE o.role = 'sole_owner' OR o.amount * 2 > c.total
  ), public_owned(eik, kind, depth) AS (
    SELECT eik,
      CASE WHEN name LIKE 'ОБЩИНА%' OR name LIKE 'СТОЛИЧНА ОБЩИНА%' THEN 'municipal' ELSE 'state' END, 0
    FROM controlled
    WHERE name LIKE 'ОБЩИНА%' OR name LIKE 'СТОЛИЧНА ОБЩИНА%' OR name LIKE '%МИНИСТЕРСТВО%'
      OR name LIKE '%МИНИСТЪР%' OR name LIKE '%ДЪРЖАВАТА%' OR name LIKE 'ДЪРЖАВА%'
      OR owner IN (SELECT eik FROM state_owned_eik WHERE ownership_kind = 'state')
    UNION
    SELECT c.eik, p.kind, p.depth + 1 FROM controlled c JOIN public_owned p ON p.eik = c.owner
    WHERE p.depth < 4
  )
  SELECT eik, MIN(kind) FROM public_owned GROUP BY eik`,
];

export async function derivePublicOwnership(db: D1Database): Promise<number> {
  await db.batch(PUBLIC_OWNERSHIP_SQL.map((sql) => db.prepare(sql)));
  return (
    (await db.prepare('SELECT COUNT(*) AS n FROM public_owned_eik').first<{ n: number }>())?.n ?? 0
  );
}
