import { streamAuthoritiesCsv, type AuthoritySort } from '@sigma/db';
import type { Route } from './+types/authorities.csv';
import { servedCsvExport } from '../lib/csv-export';
import { getMulti } from '../lib/filters';

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sort = (sp.get('sort') as AuthoritySort) || 'spent';
  const params = {
    sort,
    types: getMulti(sp, 'type'),
    sectors: getMulti(sp, 'sector'),
    years: getMulti(sp, 'year'),
    eu: (sp.get('eu') as 'eu' | 'national' | null) || null,
    q: sp.get('q'),
  };
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'authorities',
    params,
    stream: () => streamAuthoritiesCsv(context.cloudflare.env.DB, params),
  });
}
