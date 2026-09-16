// Published AV interfaces only: XML partidas + the portal's daily entry list.
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface RegistryField {
  fieldIdent: string;
  element: string;
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
export interface RegistryDeed {
  deed: RegistryDeedBody;
  deedActualState: RegistryDeedBody;
}
export type DeedLookup = { status: 'ok'; deed: RegistryDeed } | { status: 'absent' };
export interface RegistryChange {
  uic: string;
  entryDate: string;
  companyName: string;
}
export interface RegistryClientOptions {
  baseUrl: string;
  portalUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}
export class RegistryError extends Error {
  status?: number;
  retryMs?: number;
  constructor(message: string, status?: number, retryMs?: number) {
    super(message);
    this.status = status;
    this.retryMs = retryMs;
  }
}
export const REGISTRY_CHANGES_PAGE = 25;
const UIC = /^\d{9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const array = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new RegistryError('invalid registry object');
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  textNodeName: '$text',
  removeNSPrefix: true,
  trimValues: true,
});

export function parseRegistryXml(xml: string, uic: string): RegistryDeed {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new RegistryError('invalid registry XML');
  const root = object(object(parser.parse(xml)).DeedResult);
  const body = (value: unknown): RegistryDeedBody => {
    const d = object(value);
    if (d.UIC !== uic) throw new RegistryError(`registry returned no partida ${uic}`);
    return {
      uic,
      name: string(d.CompanyName),
      status: string(d.DeedStatus),
      guid: string(d.GUID),
      legalForm: string(d.LegalForm),
      subDeeds: array(d.SubDeed).map((v) => {
        const sub = object(v);
        return {
          subUic: string(sub.SubUIC),
          subUicType: string(sub.SubUICType),
          status: string(sub.SubDeedStatus),
          fields: Object.entries(sub).flatMap(([element, values]) =>
            array(values).flatMap((value) => {
              if (!value || typeof value !== 'object') return [];
              const field = object(value);
              if (!field.FieldIdent) return [];
              return [
                {
                  fieldIdent: string(field.FieldIdent),
                  element,
                  operation: string(field.FieldOperation),
                  entryNumber: string(field.FieldEntryNumber),
                  actionDate: string(field.FieldActionDate),
                  entryDate: string(field.FieldEntryDate),
                  value: field,
                },
              ];
            }),
          ),
        };
      }),
    };
  };
  return { deed: body(root.Deed), deedActualState: body(root.DeedActualState) };
}

export function registryDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
export function registryDayBoundary(day: string, end = false): string {
  // toJSON() is null for an invalid date (2026-13-01), where toISOString() would throw a RangeError.
  if (!DAY.test(day) || new Date(`${day}T12:00:00Z`).toJSON()?.slice(0, 10) !== day)
    throw new RegistryError(`not a day: ${day}`);
  // Midnight and 23:59 may have different offsets on the DST transition day.
  const utc = new Date(`${day}T${end ? '21:59:59.999' : '00:00:00'}Z`);
  const offset = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Sofia',
    timeZoneName: 'longOffset',
  })
    .formatToParts(utc)
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', '');
  return `${day}T${end ? '23:59:59.999' : '00:00:00'}${offset}`;
}
/** No cap below the server's requested delay. Workflows defer long waits durably. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header?.trim()) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
export function registryClient(opts: RegistryClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const portal = opts.portalUrl ?? 'https://portal.registryagency.bg/CR/api/Applications/Entries';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  async function get(url: string, accept: string): Promise<Response | null> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { accept },
          // Workers supports manual/follow only. Non-2xx below rejects redirects without following them.
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
      } catch (error) {
        if (attempt >= (opts.maxAttempts ?? 3))
          throw new RegistryError(`registry request failed: ${String(error)}`);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res;
      const wait =
        retryAfterMs(res.headers.get('retry-after')) ?? (res.status === 429 ? 180_000 : 30_000);
      await res.body?.cancel();
      if (res.status === 404) return null;
      // Let the durable caller postpone instead of holding a Workflow step/lease in a long sleep.
      throw new RegistryError(`registry answered ${res.status}`, res.status, wait);
    }
  }
  async function deed(uic: string): Promise<DeedLookup> {
    if (!UIC.test(uic)) throw new RegistryError(`not a partida ЕИК: ${uic}`);
    const res = await get(`${base}/deeds/${uic}`, 'application/xml');
    return res
      ? { status: 'ok', deed: parseRegistryXml(await res.text(), uic) }
      : { status: 'absent' };
  }
  async function changes(
    day: string,
    page = 1,
  ): Promise<{ items: RegistryChange[]; hasMore: boolean; total: number | null }> {
    if (!Number.isSafeInteger(page) || page < 1) throw new RegistryError('invalid portal page');
    const url = new URL(portal);
    url.search = new URLSearchParams({
      dateFrom: registryDayBoundary(day),
      dateTo: registryDayBoundary(day, true),
      page: String(page),
      pageSize: String(REGISTRY_CHANGES_PAGE),
    }).toString();
    const res = await get(url.toString(), 'application/json');
    if (!res) throw new RegistryError(`portal has no entry list for ${day}`);
    const raw: unknown = await res.json();
    if (!Array.isArray(raw) || raw.length > REGISTRY_CHANGES_PAGE)
      throw new RegistryError('invalid portal entry list');
    const items = raw.map((value) => {
      const r = object(value);
      if (
        !UIC.test(string(r.uic)) ||
        typeof r.date !== 'string' ||
        !r.date.startsWith(`${day}T`) ||
        !Number.isFinite(Date.parse(r.date))
      )
        throw new RegistryError('invalid portal entry');
      return { uic: r.uic as string, entryDate: r.date, companyName: string(r.companyFullName) };
    });
    const count = res.headers.get('Count');
    const total = page === 1 && count !== null && /^\d+$/.test(count) ? Number(count) : null;
    return { items, total, hasMore: items.length === REGISTRY_CHANGES_PAGE };
  }
  return { deed, changes };
}
export type RegistryClient = ReturnType<typeof registryClient>;
