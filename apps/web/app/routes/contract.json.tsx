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
  // escaping, JSON-equivalent, so the two can't drift. Escaping the content is defense in
  // depth; the actual MIME-sniffing guard is `X-Content-Type-Options: nosniff` \u2014 the worker sets it
  // globally (baseSecurityHeaders), and it is set explicitly here too so this resource route is safe
  // on its own, not only via the global layer.
  return withDataSource(
    new Response(serializeJsonForScript(record), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': publicCache(3600),
      },
    }),
  );
}
