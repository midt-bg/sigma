import type { AppLoadContext, EntryContext } from 'react-router';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import { NonceContext } from './nonce';
import { securityHeaders } from './lib/security';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  // Per-request nonce so a strict CSP can allow framework hydration scripts
  // without 'unsafe-inline'. Threaded to <Scripts>/<ScrollRestoration> via context.
  const nonce = crypto.randomUUID().replace(/-/g, '');

  let shellRendered = false;
  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <NonceContext.Provider value={nonce}>
      {/* `nonce` here also propagates to React Router's streaming `<script>` chunks
          (window.__reactRouterContext.streamController.enqueue …). Without it, the strict
          per-request CSP drops those scripts, loader data never reaches the client, and
          hydration silently dies — taking the header search drawer + filter-form auto-submit
          with it. */}
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      nonce,
      onError(error: unknown) {
        responseStatusCode = 500;
        // Log streaming rendering errors from inside the shell.  Don't log
        // errors encountered during initial shell rendering since they'll
        // reject and get logged in handleDocumentRequest.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  // CSP enforced in production only; dev relies on Vite's inline scripts / HMR.
  for (const [key, value] of securityHeaders(nonce, import.meta.env.PROD)) {
    responseHeaders.set(key, value);
  }

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
