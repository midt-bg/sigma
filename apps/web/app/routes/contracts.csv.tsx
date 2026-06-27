import { streamContractsCsv } from '@sigma/db';
import type { Route } from './+types/contracts.csv';
import { servedCsvExport } from '../lib/csv-export';
import { contractListParams } from '../lib/filters';

// Resource route (no default export): a streamed text/csv Response honouring the list filters. Uses
// the same contractListParams as the /contracts page so the export can never drift from the view —
// notably it now applies `?bids=1` (single-offer), which it previously ignored (#138).
export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = contractListParams(sp);
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'contracts',
    params,
    stream: () => streamContractsCsv(context.cloudflare.env.DB, params),
  });
}
