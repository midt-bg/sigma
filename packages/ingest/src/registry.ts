// The Trade Register's API, as the daily ETL reads it (ADR-0041): one partida by ЕИК, and the day's changes.
// Plain fetch and no D1, so the same client serves the Worker and a Node script alike.

/** One entry of one field of a partida, as the API returns it (XML turned into JSON, every value a string). */
export interface RegistryField {
  fieldIdent: string;
  element: string;
  /** Add | Erase | Current — an entry whose operation is Erase strikes the records it names. */
  operation: string;
  entryNumber: string;
  actionDate: string;
  entryDate: string;
  value: unknown;
}

export interface RegistrySubDeed {
  subUic: string;
  subUicType: string;
  status: string;
  fields: RegistryField[];
}

export interface RegistryDeedBody {
  uic: string;
  name: string;
  status: string;
  guid: string;
  legalForm: string;
  subDeeds: RegistrySubDeed[];
}

/** A partida: every entry ever made (`deed`), and the latest entry of every field (`deedActualState`). */
export interface RegistryDeed {
  deed: RegistryDeedBody;
  deedActualState: RegistryDeedBody;
}

export type DeedLookup = { status: 'ok'; deed: RegistryDeed } | { status: 'absent' };

/** One entry the register made on a day. */
export interface RegistryChange {
  uic: string;
  companyName: string;
  entryNumber: string;
  entryDate: string;
  fieldIdent: string;
  operation: string;
}

export interface RegistryClientOptions {
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts for a 429, a 5xx or a network failure before the request fails. */
  maxAttempts?: number;
  /** Seam for tests; the Worker and Node wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export class RegistryError extends Error {}

/** Rows per page of the changes feed — the API's own default. */
export const REGISTRY_CHANGES_PAGE = 1000;
// A day with more pages than this is not a day of the register; it is a loop.
const MAX_CHANGE_PAGES = 1000;
const MAX_RETRY_WAIT_MS = 120_000;
const UIC = /^\d{9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A response walked away from unread keeps its stream open for the rest of the invocation; release it.
function discard(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // already consumed or locked — nothing left to release
  }
}

/** The wait a 429 or 503 asks for: seconds, or an HTTP date; null when it names none. Capped. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_WAIT_MS) : null;
}

export function registryClient(opts: RegistryClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const host = new URL(base).host;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // null = 404: the register has no such record. A 429 or 5xx is waited out (Retry-After when the API names
  // it, else backoff); anything else fails loudly — a partida we could not read is unknown, never absent.
  async function get(path: string): Promise<Response | null> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxAttempts)
          throw new RegistryError(`registry request failed: ${path}: ${message(err)}`);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.url && new URL(res.url).host !== host) {
        discard(res);
        throw new RegistryError(`registry redirected ${path} away from ${host}`);
      }
      if (res.status === 404) {
        discard(res);
        return null;
      }
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** (attempt - 1);
        discard(res);
        await sleep(wait);
        continue;
      }
      discard(res);
      throw new RegistryError(`registry answered ${res.status} for ${path}`);
    }
  }

  async function deed(uic: string): Promise<DeedLookup> {
    if (!UIC.test(uic)) throw new RegistryError(`not a partida ЕИК: ${uic}`);
    const res = await get(`/deeds/${uic}`);
    if (!res) return { status: 'absent' };
    const body = (await res.json()) as Partial<RegistryDeed>;
    if (!body?.deed || !body.deedActualState || body.deed.uic !== uic)
      throw new RegistryError(`registry returned no partida ${uic}`);
    return { status: 'ok', deed: body as RegistryDeed };
  }

  async function changes(
    date: string,
    offset = 0,
  ): Promise<{ items: RegistryChange[]; hasMore: boolean }> {
    if (!DAY.test(date)) throw new RegistryError(`not a day: ${date}`);
    const res = await get(
      `/deeds/changes?date=${date}&by=loaded&limit=${REGISTRY_CHANGES_PAGE}&offset=${offset}`,
    );
    if (!res) throw new RegistryError(`registry has no changes feed for ${date}`);
    const body = (await res.json()) as { items?: RegistryChange[]; hasMore?: boolean };
    return { items: body.items ?? [], hasMore: Boolean(body.hasMore) };
  }

  /** Every partida the register touched on `date` (the API's load day), once each. */
  async function changedUics(date: string): Promise<string[]> {
    const uics = new Set<string>();
    let offset = 0;
    for (let page = 0; ; page++) {
      if (page >= MAX_CHANGE_PAGES)
        throw new RegistryError(`changes feed for ${date} did not end within ${page} pages`);
      const { items, hasMore } = await changes(date, offset);
      for (const c of items) if (UIC.test(c.uic)) uics.add(c.uic);
      if (!hasMore || items.length === 0) break;
      offset += items.length;
    }
    return [...uics].sort();
  }

  return { deed, changes, changedUics };
}

export type RegistryClient = ReturnType<typeof registryClient>;
