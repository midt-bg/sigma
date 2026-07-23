import { contractIdFromSlug, getContract, getDb } from '@sigma/db';
import type { Route } from './+types/contract.json';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\//g, '<\\/');
}

// Resource route: the assembled contract record as machine-readable JSON (/contracts/:id.json).
export async function loader({ params, context }: Route.LoaderArgs) {
  const id = (params.id ?? '').replace(/\.json$/, '');
  const record = await getContract(getDb(context.cloudflare.env), contractIdFromSlug(id));
  if (!record) return withDataSource(Response.json({ error: 'not_found' }, { status: 404 }));
  return withDataSource(
    new Response(safeJson(record), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': publicCache(3600),
      },
    }),
  );
}
