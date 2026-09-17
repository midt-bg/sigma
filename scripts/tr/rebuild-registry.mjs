#!/usr/bin/env node
// A full Trade Register import into a local SQLite file, through the daily ETL's own queue, reader and
// writer (ADR-0041), ending with the accepted baseline the daily passes continue from (ADR-0048).
//
//   node --import ./scripts/cacbg/register-ts.mjs scripts/tr/rebuild-registry.mjs --db <file>
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { registryClient, registryDay } from '../../packages/ingest/src/registry.ts';
import {
  completeEntryBaseline,
  nextQueued,
  prepareEntryBaseline,
  queueNewWinners,
  storeDeed,
} from '../../apps/etl/src/registry.ts';
import { d1FromSqlite } from '../../packages/test-support/src/d1-sqlite.ts';
import { progress } from '../cacbg/progress.mjs';

const ATTEMPTS = 5;

/** Read every winner never read, one partida at a time; a partida that keeps failing stops the import. */
export async function importRegistry(
  d1,
  client,
  { runId, now = () => new Date(), wait = pause } = {},
) {
  const startedAt = now().toISOString();
  const baseline = await prepareEntryBaseline(d1, registryDay(now()), runId, startedAt);
  if (baseline !== 'building') throw new Error(`The registry is not empty (${baseline})`);
  await queueNewWinners(d1, startedAt, Number.MAX_SAFE_INTEGER);
  let read = 0;
  for (;;) {
    const eiks = await nextQueued(d1, 50, now().toISOString());
    if (!eiks.length) break;
    for (const eik of eiks) {
      for (let attempt = 1; ; attempt++) {
        try {
          await storeDeed(d1, eik, await client.deed(eik), now().toISOString());
          break;
        } catch (error) {
          if (attempt >= ATTEMPTS) throw new Error(`Partida ${eik}: ${error}`);
          await wait(1000 * 2 ** attempt);
        }
      }
      progress('registry', ++read);
    }
  }
  if (!(await completeEntryBaseline(d1, runId, now().toISOString())))
    throw new Error('The registry import did not reach an accepted baseline');
  return read;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { db: { type: 'string' } } });
  if (!values.db) throw new Error('--db required');
  const db = new DatabaseSync(values.db);
  const client = registryClient({
    baseUrl: process.env.REGISTRY_API_BASE_URL ?? 'https://api-sigma-cr.registryagency.bg',
    portalUrl: process.env.REGISTRY_PORTAL_URL,
  });
  const read = await importRegistry(d1FromSqlite(db), client, {
    runId: process.env.SIGMA_RUN_ID ?? `rebuild-${Date.now()}`,
  });
  db.close();
  console.log(JSON.stringify({ event: 'rebuild_registry_complete', read }));
}
