import { contractIdFromSlug, getContract } from '@sigma/db';
import type { Route } from './+types/contract.json';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';
import { serializeJsonForScript } from '../lib/json-ld';

// Resource route: the assembled contract record as machine-readable JSON (/contracts/:id.json).
export async function loader({ params, context }: Route.LoaderArgs) {
  const id = (params.id ?? '').replace(/\.json$/, '');
  const record = await getContract(context.cloudflare.env.DB, contractIdFromSlug(id));
  if (!record) return withDataSource(Response.json({ error: 'not_found' }, { status: 404 }));
  // Shared serializer (lib/json-ld.ts) instead of a second local copy \u2014 same `<`/U+2028/U+2029
  // escaping, JSON-equivalent, so the two can't drift (review). It escapes every `<` (stronger than
  // the old `</`-only form) which is harmless here and defends the body if it is ever sniffed as HTML.
  return withDataSource(
    new Response(serializeJsonForScript(record), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': publicCache(3600),
      },
    }),
  );
}
