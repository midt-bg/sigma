import {
  classifyBucketKey,
  computeCatchupWindow,
  daysInWindow,
  mapBaseRecord,
  releaseToAmendments,
  releaseToContracts,
  releaseToLots,
  releaseToParties,
  upsertAmendmentStaging,
  upsertBaseAmendmentStaging,
  upsertBaseContractStaging,
  upsertBaseTenderStaging,
  upsertContractStaging,
  upsertLotStaging,
  upsertPartyStaging,
  type BucketKeyKind,
  type OcdsMeta,
  type OcdsPackage,
} from '@sigma/ingest';

const DEFAULT_BASE_URL = 'https://storage.eop.bg';
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_WORKER_WINDOW_DAYS = 21;
const MS_PER_DAY = 86_400_000;

type BucketKeys = Partial<Record<BucketKeyKind, string>>;

interface FreshnessRow {
  max_loaded_date: string | null;
}

export interface CatchupPlan {
  maxLoadedDate: string | null;
  from: string;
  to: string;
  gapDays: number;
  capped: boolean;
  originalFrom: string;
  originalGapDays: number;
  /** The unfinished earlier window this plan replays (folded into `from`), or null. */
  replayFrom: string | null;
}

export interface BucketListing {
  day: string;
  bucketUrl: string;
  keys: BucketKeys;
}

export interface OcdsStageCounts {
  ocdsContracts: number;
  ocdsAmendments: number;
  parties: number;
  lots: number;
}

export interface BaseStageCounts {
  baseContracts: number;
  baseTenders: number;
  baseAmendments: number;
}

export interface DayIngestResult extends OcdsStageCounts, BaseStageCounts {
  day: string;
  found: boolean;
}

const dayUrl = (baseUrl: string, day: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/open-data-${day}/`;

const objectUrl = (bucketUrl: string, key: string): string =>
  `${bucketUrl}${encodeURIComponent(key)}`;

function disallowedFinalHost(requestUrl: string, responseUrl: string): string | null {
  const requested = new URL(requestUrl);
  const final = new URL(responseUrl || requestUrl);
  if (final.host === requested.host) return null;
  return `blocked redirected EOP fetch from ${requested.host} to ${final.host}`;
}

// A response body that is never read keeps its stream open for the rest of the invocation; the
// collector is not a substitute for releasing it. Every path below that walks away from a response
// without reading it - a blocked redirect, a missing bucket, any non-OK status - releases it here.
// Deliberately NOT awaited: cancelling only needs to be INITIATED for the runtime to release the
// stream, and awaiting it would make every caller hostage to a cancel() that never settles, which
// is precisely the failure mode this file exists to reduce.
function discardBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // Already consumed, locked, or errored - there is nothing left to release either way.
  }
}

function releaseAndFail(res: Response, message: string): never {
  discardBody(res);
  throw new Error(message);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseBucketKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) keys.push(decodeXml(m[1] ?? ''));
  return keys;
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function enumerateDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let t = start; t <= end; t += MS_PER_DAY) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

function packageReleases(
  pkg: OcdsPackage | { data?: OcdsPackage },
): NonNullable<OcdsPackage['releases']> {
  if ('releases' in pkg && Array.isArray(pkg.releases)) return pkg.releases;
  if ('data' in pkg && Array.isArray(pkg.data?.releases)) return pkg.data.releases;
  return [];
}

function packagePublishedDate(pkg: OcdsPackage | { data?: OcdsPackage }): string | undefined {
  if ('publishedDate' in pkg && pkg.publishedDate) return pkg.publishedDate;
  if ('data' in pkg) return pkg.data?.publishedDate;
  return undefined;
}

export async function latestLoadedDate(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MAX(as_of) AS max_loaded_date
       FROM data_freshness
       WHERE source IN ('eop', 'ocds')
         AND as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    )
    .first<FreshnessRow>();
  return row?.max_loaded_date ?? null;
}

export async function computeWorkerCatchupPlan(
  db: D1Database,
  opts: {
    today?: string;
    lookbackDays?: number;
    maxWindowDays?: number;
    /**
     * Every window an earlier run started and never settled (see pendingWindows). The plan widens
     * its START back to the oldest promise (before the cap) so those days are loaded again; its END
     * is always this run's own `today` — a promise's tail beyond it is not loaded now, it simply
     * stays outstanding (settlement subtracts only what was covered). Never widening the end keeps a
     * backdated manual run on the window the operator asked for instead of displacing it.
     */
    replay?: { from: string; to: string }[];
  } = {},
): Promise<CatchupPlan> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxWindowDays = opts.maxWindowDays ?? MAX_WORKER_WINDOW_DAYS;
  const maxLoadedDate = await latestLoadedDate(db);
  const own = computeCatchupWindow({ maxLoadedDate, today, lookbackDays });
  const replay = opts.replay ?? [];
  const replayFrom = replay.length ? replay.map((w) => w.from).sort()[0]! : null;
  // The end is this run's own today, never a promise's — and never past the real calendar day:
  // buckets for the future do not exist, and an end there would cap the start past today's bucket.
  const realToday = new Date().toISOString().slice(0, 10);
  const to = own.to > realToday ? realToday : own.to;
  const widenedFrom = replayFrom && replayFrom < own.from ? replayFrom : own.from;
  // A manual `today` in the future is clamped above; the start must not outrun the clamped end.
  const window = { from: widenedFrom > to ? to : widenedFrom, to };
  const originalGapDays = daysInWindow(window.from, window.to);
  if (originalGapDays <= maxWindowDays) {
    return {
      maxLoadedDate,
      from: window.from,
      to: window.to,
      gapDays: originalGapDays,
      capped: false,
      originalFrom: window.from,
      originalGapDays,
      replayFrom,
    };
  }

  const cappedFrom = addDays(window.to, -(maxWindowDays - 1));
  return {
    maxLoadedDate,
    from: cappedFrom,
    to: window.to,
    gapDays: daysInWindow(cappedFrom, window.to),
    capped: true,
    originalFrom: window.from,
    originalGapDays,
    replayFrom,
  };
}

export async function listBucketForDay(
  day: string,
  opts: { baseUrl?: string } = {},
): Promise<BucketListing | null> {
  const bucketUrl = dayUrl(opts.baseUrl ?? DEFAULT_BASE_URL, day);
  const res = await fetch(bucketUrl);
  const blocked = disallowedFinalHost(bucketUrl, res.url);
  if (blocked) return releaseAndFail(res, blocked);
  if (res.status === 403 || res.status === 404) {
    discardBody(res);
    return null;
  }
  if (!res.ok) return releaseAndFail(res, `bucket ${day}: HTTP ${res.status}`);

  const keys: BucketKeys = {};
  for (const key of parseBucketKeys(await res.text())) {
    const kind = classifyBucketKey(key);
    if (kind && !keys[kind]) keys[kind] = key;
  }
  return { day, bucketUrl, keys };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const blocked = disallowedFinalHost(url, res.url);
  if (blocked) return releaseAndFail(res, blocked);
  if (!res.ok) return releaseAndFail(res, `${url}: HTTP ${res.status}`);
  return res.json();
}

export async function stageOcdsFromBucket(
  db: D1Database,
  listing: BucketListing,
  fetchedAt: string,
): Promise<OcdsStageCounts> {
  const key = listing.keys.ocds;
  const source = `ocds:${listing.day}`;
  if (!key) {
    await Promise.all([
      upsertContractStaging(db, source, []),
      upsertAmendmentStaging(db, source, []),
      upsertPartyStaging(db, source, []),
      upsertLotStaging(db, source, []),
    ]);
    return { ocdsContracts: 0, ocdsAmendments: 0, parties: 0, lots: 0 };
  }

  const resourceUri = objectUrl(listing.bucketUrl, key);
  const pkg = (await fetchJson(resourceUri)) as OcdsPackage | { data?: OcdsPackage };
  const meta: OcdsMeta = {
    source,
    datasetUri: listing.bucketUrl,
    resourceUri,
    year: Number(listing.day.slice(0, 4)),
    fetchedAt,
    publishedDate: packagePublishedDate(pkg),
  };

  const releases = packageReleases(pkg);
  const contracts = releases.flatMap((rel) => releaseToContracts(rel, meta));
  const amendments = releases.flatMap((rel) => releaseToAmendments(rel, meta));
  const parties = releases.flatMap((rel) => releaseToParties(rel, meta));
  const lots = releases.flatMap((rel) => releaseToLots(rel, meta));

  await upsertContractStaging(db, source, contracts);
  await upsertAmendmentStaging(db, source, amendments);
  await upsertPartyStaging(db, source, parties);
  await upsertLotStaging(db, source, lots);

  return {
    ocdsContracts: contracts.length,
    ocdsAmendments: amendments.length,
    parties: parties.length,
    lots: lots.length,
  };
}

function jsonArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label}: object JSON is not an array`);
  return value as Record<string, unknown>[];
}

export async function stageBaseFromBucket(
  db: D1Database,
  listing: BucketListing,
  fetchedAt: string,
): Promise<BaseStageCounts> {
  const counts: BaseStageCounts = { baseContracts: 0, baseTenders: 0, baseAmendments: 0 };

  if (listing.keys.contracts) {
    const rows = jsonArray(
      await fetchJson(objectUrl(listing.bucketUrl, listing.keys.contracts)),
      `contracts ${listing.day}`,
    )
      .map((record) => mapBaseRecord('contracts', record, { day: listing.day, fetchedAt }))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    counts.baseContracts = await upsertBaseContractStaging(
      db,
      `eop:contracts:${listing.day}`,
      rows,
    );
  }

  if (listing.keys.tenders) {
    const rows = jsonArray(
      await fetchJson(objectUrl(listing.bucketUrl, listing.keys.tenders)),
      `tenders ${listing.day}`,
    )
      .map((record) => mapBaseRecord('tenders', record, { day: listing.day, fetchedAt }))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    counts.baseTenders = await upsertBaseTenderStaging(db, `eop:tenders:${listing.day}`, rows);
  }

  if (listing.keys.annexes) {
    const rows = jsonArray(
      await fetchJson(objectUrl(listing.bucketUrl, listing.keys.annexes)),
      `annexes ${listing.day}`,
    )
      .map((record) => mapBaseRecord('annexes', record, { day: listing.day, fetchedAt }))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    counts.baseAmendments = await upsertBaseAmendmentStaging(
      db,
      `eop:annexes:${listing.day}`,
      rows,
    );
  }

  return counts;
}

export async function ingestBucketWindow(
  db: D1Database,
  plan: Pick<CatchupPlan, 'from' | 'to'>,
  opts: { baseUrl?: string; fetchedAt?: string } = {},
): Promise<DayIngestResult[]> {
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const out: DayIngestResult[] = [];
  for (const day of enumerateDays(plan.from, plan.to)) {
    const listing = await listBucketForDay(day, { baseUrl: opts.baseUrl });
    if (!listing) {
      out.push({
        day,
        found: false,
        baseContracts: 0,
        baseTenders: 0,
        baseAmendments: 0,
        ocdsContracts: 0,
        ocdsAmendments: 0,
        parties: 0,
        lots: 0,
      });
      continue;
    }

    const baseCounts = await stageBaseFromBucket(db, listing, fetchedAt);
    const ocdsCounts = await stageOcdsFromBucket(db, listing, fetchedAt);
    out.push({ day, found: true, ...baseCounts, ...ocdsCounts });
  }
  return out;
}
