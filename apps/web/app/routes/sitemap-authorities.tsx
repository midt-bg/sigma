import { streamAuthoritySitemap, getDb } from '@sigma/db';
import type { Route } from './+types/sitemap-authorities';
import { withDataSource } from '../lib/dataSource';

export function loader({ request, context }: Route.LoaderArgs) {
  return withDataSource(
    streamAuthoritySitemap(getDb(context.cloudflare.env), new URL(request.url).origin),
  );
}
