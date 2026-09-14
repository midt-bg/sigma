import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DeclarationEnv } from './declarations';

const prefix = 'declarations/corpus-v2/';
const folder = /^20\d{2}[A-Za-z0-9_]{0,8}\/$/;
const keyPattern =
  /^(?:\.corpus-complete\.json|accepted\.json|20\d{2}[A-Za-z0-9_]{0,8}\/(?:[A-Za-z0-9._-]+\.xml|\.index\.json))$/;

// A loopback entrypoint used only by the Container's private outbound handler.
export class DeclarationCorpus extends WorkerEntrypoint<DeclarationEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bucket = this.env.DECLARATIONS_CORPUS;
    if (url.hostname !== 'declarations.r2' || !bucket) return new Response(null, { status: 404 });
    if (url.pathname === '/' && request.method === 'GET') {
      const requested = url.searchParams.get('prefix') ?? '';
      if (!folder.test(requested)) return new Response(null, { status: 400 });
      const options = {
        prefix: prefix + requested,
        cursor: url.searchParams.get('cursor') || undefined,
        limit: 1000,
        include: ['customMetadata'],
      };
      const page = await bucket.list(options);
      return Response.json({
        objects: page.objects.map((o) => ({
          key: o.key.slice(prefix.length),
          sha256: o.customMetadata?.sha256,
        })),
        truncated: page.truncated,
        cursor: page.truncated ? page.cursor : undefined,
      });
    }
    const key = url.pathname.slice(1);
    if (!keyPattern.test(key)) return new Response(null, { status: 400 });
    if (request.method === 'GET') {
      const object = await bucket.get(prefix + key);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, {
        headers: {
          'x-corpus-sha256': object.customMetadata?.sha256 ?? '',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method === 'PUT') {
      const sha256 = request.headers.get('x-corpus-sha256') ?? '';
      if (!/^[a-f0-9]{64}$/.test(sha256) || !request.body)
        return new Response(null, { status: 400 });
      await bucket.put(prefix + key, request.body, {
        sha256,
        customMetadata: { sha256 },
        httpMetadata: {
          contentType: key.endsWith('.xml') ? 'application/xml' : 'application/json',
        },
      });
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE' && key === '.corpus-complete.json') {
      await bucket.delete(prefix + key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }
}
