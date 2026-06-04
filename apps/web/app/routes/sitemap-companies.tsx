import { streamCompanySitemap } from '@sigma/db';
import type { Route } from './+types/sitemap-companies';
import { withDataSource } from '../lib/dataSource';

export function loader({ request, context }: Route.LoaderArgs) {
  return withDataSource(
    streamCompanySitemap(context.cloudflare.env.DB, new URL(request.url).origin),
  );
}
