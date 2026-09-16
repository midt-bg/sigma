import {
  addDays,
  assertSameFinalHost,
  BASE_STAGING,
  classifyBucketKey,
  computeCatchupWindow,
  daysInWindow,
  discardBody,
  mapBaseRecord,
  OCDS_STAGING,
  releaseToAmendments,
  releaseToContracts,
  releaseToLots,
  releaseToParties,
  upsertStagingRows,
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
  const capped = originalGapDays > maxWindowDays;
  const from = capped ? addDays(window.to, -(maxWindowDays - 1)) : window.from;
  return {
    maxLoadedDate,
    from,
    to: window.to,
    gapDays: daysInWindow(from, window.to),
    capped,
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
  try {
    assertSameFinalHost(bucketUrl, res.url, 'EOP');
  } catch (err) {
    discardBody(res);
    throw err;
  }
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
  try {
    assertSameFinalHost(url, res.url, 'EOP');
  } catch (err) {
    discardBody(res);
    throw err;
  }
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
      upsertStagingRows(db, OCDS_STAGING.contracts, source, []),
      upsertStagingRows(db, OCDS_STAGING.amendments, source, []),
      upsertStagingRows(db, OCDS_STAGING.parties, source, []),
      upsertStagingRows(db, OCDS_STAGING.lots, source, []),
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

  await upsertStagingRows(db, OCDS_STAGING.contracts, source, contracts);
  await upsertStagingRows(db, OCDS_STAGING.amendments, source, amendments);
  await upsertStagingRows(db, OCDS_STAGING.parties, source, parties);
  await upsertStagingRows(db, OCDS_STAGING.lots, source, lots);

  return {
    ocdsContracts: contracts.length,
    ocdsAmendments: amendments.length,
    parties: parties.length,
    lots: lots.length,
  };
}

// Bucket key kind → its count field, in staging order.
const BASE_STAGES = [
  ['contracts', 'baseContracts'],
  ['tenders', 'baseTenders'],
  ['annexes', 'baseAmendments'],
] as const;

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

  for (const [cat, count] of BASE_STAGES) {
    const key = listing.keys[cat];
    if (!key) continue;
    const rows = jsonArray(
      await fetchJson(objectUrl(listing.bucketUrl, key)),
      `${cat} ${listing.day}`,
    )
      .map((record) => mapBaseRecord(cat, record, { day: listing.day, fetchedAt }))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    counts[count] = await upsertStagingRows(
      db,
      BASE_STAGING[cat],
      `eop:${cat}:${listing.day}`,
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
