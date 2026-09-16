// Sitemaps — streamed XML (the corpus is large: 4.9k authorities, 17k companies, 190k contracts).
// A sitemap index points at per-type sitemaps; contracts paginate under the 50k-URL limit. URLs use
// the same slugs as the routes (companySlug encodes name-keyed bidders).

import { isNaturalPersonProfileName } from '@sigma/shared';
import { companySlug, contractSlug } from './identity';

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const TAIL = '</urlset>\n';
const CHUNK = 5000;

const CONTRACTS_PER_SITEMAP = 45000;

function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// W3C <lastmod> from a stored ISO date (tolerates a datetime suffix); '' when none usable.
function lastmod(iso: string | null | undefined): string {
  const m = iso && /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? `<lastmod>${m[1]}</lastmod>` : '';
}

// Dataset freshness date (latest real contract date), used as the per-URL <lastmod> fallback.
async function datasetAsOf(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT as_of FROM home_totals WHERE id = 1`)
    .first<{ as_of: string | null }>();
  return row?.as_of ?? null;
}

function streamUrls(
  origin: string,
  fetchChunk: (after: string) => Promise<{ slugs: string[]; next: string | null }>,
): Response {
  const enc = new TextEncoder();
  let after = '';
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(HEAD));
    },
    async pull(controller) {
      if (done) return;
      let slugs: string[] = [];
      let next: string | null = null;
      do {
        const chunk = await fetchChunk(after);
        slugs = chunk.slugs;
        next = chunk.next;
        after = next ?? after;
      } while (slugs.length === 0 && next !== null);
      if (slugs.length === 0 || next === null) {
        if (slugs.length) controller.enqueue(enc.encode(slugs.join('')));
        controller.enqueue(enc.encode(TAIL));
        done = true;
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(slugs.join('')));
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/** Streamed sitemap of all authority profile URLs. */
export function streamAuthoritySitemap(db: D1Database, origin: string): Response {
  const asOf = datasetAsOf(db);
  return streamUrls(origin, async (after) => {
    const { results } = await db
      .prepare(
        `SELECT authority_id, last_date FROM authority_totals WHERE authority_id > ? ORDER BY authority_id LIMIT ?`,
      )
      .bind(after, CHUNK)
      .all<{ authority_id: string; last_date: string | null }>();
    const fallback = await asOf;
    const slugs = results.map(
      (r) =>
        `<url><loc>${xmlEscape(origin)}/authorities/${xmlEscape(r.authority_id.replace(/^auth:/, ''))}</loc>${lastmod(r.last_date ?? fallback)}</url>\n`,
    );
    const last = results[results.length - 1];
    return { slugs, next: results.length < CHUNK || !last ? null : last.authority_id };
  });
}

/** Streamed sitemap of all company profile URLs. */
export function streamCompanySitemap(db: D1Database, origin: string): Response {
  const asOf = datasetAsOf(db);
  return streamUrls(origin, async (after) => {
    const { results } = await db
      .prepare(
        `SELECT ct.bidder_id, ct.name, ct.last_date, b.legal_form FROM company_totals ct LEFT JOIN bidders b ON b.id = ct.bidder_id WHERE ct.bidder_id > ? ORDER BY ct.bidder_id LIMIT ?`,
      )
      .bind(after, CHUNK)
      .all<{
        bidder_id: string;
        name: string;
        legal_form?: string | null;
        last_date: string | null;
      }>();
    const fallback = await asOf;
    const slugs = results
      .filter((r) => !isNaturalPersonProfileName(r.name, r.legal_form))
      .map(
        (r) =>
          `<url><loc>${xmlEscape(origin)}/companies/${xmlEscape(companySlug(r.bidder_id))}</loc>${lastmod(r.last_date ?? fallback)}</url>\n`,
      );
    const last = results[results.length - 1];
    return { slugs, next: results.length < CHUNK || !last ? null : last.bidder_id };
  });
}

/** Streamed sitemap of one contracts page (dense rowid range), under the 50k-URL limit. */
export function streamContractSitemap(db: D1Database, origin: string, page: number): Response {
  const lo = (page - 1) * CONTRACTS_PER_SITEMAP;
  const hi = page * CONTRACTS_PER_SITEMAP;
  let after = lo;
  let done = false;
  let fallback: string | null = null;
  let fallbackLoaded = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(HEAD));
    },
    async pull(controller) {
      if (done) return;
      if (!fallbackLoaded) {
        fallback = await datasetAsOf(db);
        fallbackLoaded = true;
      }
      const { results } = await db
        .prepare(
          `SELECT c.rowid AS rid, c.id, c.signed_at, c.published_at, b.name AS bidder_name, b.legal_form FROM contracts c LEFT JOIN bidders b ON b.id = c.bidder_id WHERE c.rowid > ? AND c.rowid <= ? ORDER BY c.rowid LIMIT ?`,
        )
        .bind(after, hi, CHUNK)
        .all<{
          rid: number;
          id: string;
          bidder_name?: string;
          legal_form?: string | null;
          signed_at: string | null;
          published_at: string | null;
        }>();
      if (results.length === 0) {
        controller.enqueue(enc.encode(TAIL));
        done = true;
        controller.close();
        return;
      }
      const block = results
        .filter((r) => !isNaturalPersonProfileName(r.bidder_name ?? '', r.legal_form))
        .map(
          (r) =>
            `<url><loc>${xmlEscape(origin)}/contracts/${xmlEscape(contractSlug(r.id))}</loc>${lastmod(r.signed_at ?? r.published_at ?? fallback)}</url>\n`,
        )
        .join('');
      controller.enqueue(enc.encode(block));
      after = results[results.length - 1]!.rid;
      if (results.length < CHUNK) {
        controller.enqueue(enc.encode(TAIL));
        done = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/** Number of contract sitemap pages (from the corpus size in home_totals). */
export async function contractSitemapPages(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT contracts FROM home_totals WHERE id = 1`)
    .first<{ contracts: number }>();
  return Math.max(1, Math.ceil((row?.contracts ?? 0) / CONTRACTS_PER_SITEMAP));
}
