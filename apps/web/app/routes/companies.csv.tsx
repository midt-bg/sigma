import { streamCompaniesCsv } from '@sigma/db';
import type { Route } from './+types/companies.csv';
import { companyListParams } from '../lib/filters';
import { withDataSource } from '../lib/dataSource';

export function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  return withDataSource(streamCompaniesCsv(context.cloudflare.env.DB, companyListParams(sp)));
}
