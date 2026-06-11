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

function assertAllowedFinalHost(requestUrl: string, responseUrl: string): void {
  const requested = new URL(requestUrl);
  const final = new URL(responseUrl || requestUrl);
  if (final.host !== requested.host) {
    throw new Error(`blocked redirected EOP fetch from ${requested.host} to ${final.host}`);
  }
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

function addDays(day: string, days: number): string {
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
  opts: { today?: string; lookbackDays?: number; maxWindowDays?: number } = {},
): Promise<CatchupPlan> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxWindowDays = opts.maxWindowDays ?? MAX_WORKER_WINDOW_DAYS;
  const maxLoadedDate = await latestLoadedDate(db);
  const window = computeCatchupWindow({ maxLoadedDate, today, lookbackDays });
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
    };
  }

  const cappedFrom = addDays(today, -(maxWindowDays - 1));
  return {
    maxLoadedDate,
    from: cappedFrom,
    to: today,
    gapDays: daysInWindow(cappedFrom, today),
    capped: true,
    originalFrom: window.from,
    originalGapDays,
  };
}

export async function listBucketForDay(
  day: string,
  opts: { baseUrl?: string } = {},
): Promise<BucketListing | null> {
  const bucketUrl = dayUrl(opts.baseUrl ?? DEFAULT_BASE_URL, day);
  const res = await fetch(bucketUrl);
  assertAllowedFinalHost(bucketUrl, res.url);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`bucket ${day}: HTTP ${res.status}`);

  const keys: BucketKeys = {};
  for (const key of parseBucketKeys(await res.text())) {
    const kind = classifyBucketKey(key);
    if (kind && !keys[kind]) keys[kind] = key;
  }
  return { day, bucketUrl, keys };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  assertAllowedFinalHost(url, res.url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
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
