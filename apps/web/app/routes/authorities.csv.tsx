import { streamAuthoritiesCsv } from '@sigma/db';
import type { Route } from './+types/authorities.csv';
import { servedCsvExport } from '../lib/csv-export';
import { authorityListFilters } from '../lib/filters';

// Filters via the shared parser so the export can never drop a filter the HTML list applies (#138).
export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = authorityListFilters(sp);
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'authorities',
    params,
    stream: () => streamAuthoritiesCsv(context.cloudflare.env.DB, params),
  });
}
