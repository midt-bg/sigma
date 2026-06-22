import { streamContractsCsv, normalizeContractSort } from '@sigma/db';
import type { Route } from './+types/contracts.csv';
import { servedCsvExport } from '../lib/csv-export';
import { getMulti } from '../lib/filters';

// Resource route (no default export): a streamed text/csv Response honouring the list filters.
export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sort = normalizeContractSort(sp.get('sort'));
  const params = {
    sort,
    years: getMulti(sp, 'year'),
    sectors: getMulti(sp, 'sector'),
    procedureGroups: getMulti(sp, 'procedure'),
    valueBucket: sp.get('value'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    authority: sp.get('authority'),
    bidder: sp.get('bidder'),
    q: sp.get('q'),
  };
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'contracts',
    params,
    stream: () => streamContractsCsv(context.cloudflare.env.DB, params),
  });
}
