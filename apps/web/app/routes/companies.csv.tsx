import { streamCompaniesCsv } from '@sigma/db';
import type { Route } from './+types/companies.csv';
import { servedCsvExport } from '../lib/csv-export';
import { companyListParams } from '../lib/filters';

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = companyListParams(sp);
  return servedCsvExport({
    env: context.cloudflare.env,
    request,
    route: 'companies',
    params,
    stream: () => streamCompaniesCsv(context.cloudflare.env.DB, params),
  });
}
