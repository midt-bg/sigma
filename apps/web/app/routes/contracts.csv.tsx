import { streamContractsCsv } from '@sigma/db';
import type { Route } from './+types/contracts.csv';
import { servedCsvExport } from '../lib/csv-export';
import { contractListFilters } from '../lib/filters';

// Resource route (no default export): a streamed text/csv Response honouring the list filters.
// The filter set is read via the shared contractListFilters() so the export can never drop a filter
// the HTML list applies (issue #138 — a dropped `bids` made the CSV ignore „само една оферта").
export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = contractListFilters(sp);
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'contracts',
    params,
    stream: () => streamContractsCsv(context.cloudflare.env.DB, params),
  });
}
