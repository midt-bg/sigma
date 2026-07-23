import { streamContractSitemap, getDb } from '@sigma/db';
import type { Route } from './+types/sitemap-contracts';
import { withDataSource } from '../lib/dataSource';

export function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const rawPage = url.searchParams.get('p');
  if (rawPage !== null && !/^[1-9][0-9]*$/.test(rawPage)) {
    return new Response('Not found', { status: 404 });
  }

  const page = rawPage === null ? 1 : Number(rawPage);
  return withDataSource(streamContractSitemap(getDb(context.cloudflare.env), url.origin, page));
}
