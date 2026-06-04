import { listRecentTenders } from '@sigma/db';

export interface Env {
  DB: D1Database;
  ADMIN_BASIC_AUTH_USER?: string;
  ADMIN_BASIC_AUTH_PASS?: string;
  ADMIN_ALLOW_UNAUTH?: string;
}

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPE[c]!);
}

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Sigma Admin"' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return diff === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_BASIC_AUTH_PASS) return env.ADMIN_ALLOW_UNAUTH === 'true';
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;

  try {
    const decoded = atob(header.slice('Basic '.length));
    const sep = decoded.indexOf(':');
    if (sep < 0) return false;

    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);

    return (
      user === (env.ADMIN_BASIC_AUTH_USER ?? 'admin') &&
      constantTimeEqual(pass, env.ADMIN_BASIC_AUTH_PASS)
    );
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'sigma-admin' });
    }

    if (!isAuthorized(request, env)) return unauthorized();

    const tenders = await listRecentTenders(env.DB, 10);
    const rows = tenders
      .map(
        (t) =>
          `<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.status)}</td></tr>`,
      )
      .join('');
    const html = `<!doctype html>
<html lang="bg">
  <head><meta charset="utf-8" /><title>Sigma — Админ</title></head>
  <body>
    <h1>Sigma — контролен панел</h1>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>ID</th><th>Поръчка</th><th>Статус</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </body>
</html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
} satisfies ExportedHandler<Env>;
