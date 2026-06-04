import { getTenderById, listRecentTenders, sectorBreakdown, type TenderRow } from '@sigma/db';
import {
  type SearchTendersResponse,
  type SectorsResponse,
  type TenderDetail,
  type TenderSummary,
} from '@sigma/api-contract';
import { CPV_SECTORS, sectorForCpv } from '@sigma/config';

export interface Env {
  DB: D1Database;
}

function apiSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // HSTS should be added in prod once HTTPS-only deployment is confirmed.
    // Exact licence/attribution text is a team/legal decision.
    'X-Data-Source': 'AOP/TR via data.egov.bg',
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(apiSecurityHeaders())) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function toSummary(t: TenderRow): TenderSummary {
  const sector = sectorForCpv(t.cpv_code);
  return {
    id: t.id,
    title: t.title,
    // TODO: JOIN authorities for the real display name once the parked API has a tender DTO/query.
    authorityName: t.authority_id.replace(/^auth:/, ''),
    estimatedValue:
      t.estimated_value != null ? { amount: t.estimated_value, currency: 'BGN' } : null,
    status: t.status,
    riskScore: null,
    riskBand: null,
    publishedAt: t.published_at,
    sector: sector ? (sector.short ?? sector.label) : null,
    sectorCode: sector?.code ?? null,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'sigma-api' });
    }

    if (url.pathname === '/api/tenders' && request.method === 'GET') {
      const rawLimit = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
      // ?sector= accepts a 2-digit CPV division, a curated short name, or a full division label.
      const sectorParam = url.searchParams.get('sector');
      const division = sectorParam
        ? (CPV_SECTORS.find(
            (s) => s.code === sectorParam || s.short === sectorParam || s.label === sectorParam,
          )?.code ?? sectorParam)
        : null;
      const rows = await listRecentTenders(env.DB, limit, division);
      const body: SearchTendersResponse = { results: rows.map(toSummary), cursor: null };
      return json(body);
    }

    if (url.pathname === '/api/sectors' && request.method === 'GET') {
      const rows = await sectorBreakdown(env.DB);
      const byDivision = new Map(rows.map((r) => [r.division, r]));
      const sectors = CPV_SECTORS.map((s) => {
        const r = byDivision.get(s.code);
        return {
          code: s.code,
          label: s.short ?? s.label,
          curated: !!s.curated,
          contracts: r?.contracts ?? 0,
          valueEur: Math.round(r?.value_eur ?? 0),
        };
      }).sort((a, b) => b.valueEur - a.valueEur);
      const body: SectorsResponse = { sectors };
      return json(body);
    }

    const detailMatch = url.pathname.match(/^\/api\/tenders\/([^/]+)$/);
    if (detailMatch && request.method === 'GET') {
      const tender = await getTenderById(env.DB, decodeURIComponent(detailMatch[1]!));
      if (!tender) {
        return json({ error: 'not_found', message: 'Tender not found' }, { status: 404 });
      }
      const detail: TenderDetail = {
        ...toSummary(tender),
        cpvCode: tender.cpv_code,
        procedureType: tender.procedure_type,
        deadlineAt: tender.deadline_at,
        signals: null,
      };
      return json(detail);
    }

    return json({ error: 'not_found', message: 'Route not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
