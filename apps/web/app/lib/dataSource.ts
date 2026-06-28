export const DATA_SOURCE = 'AOP/CAIS EOP open-data (storage.eop.bg)';

export function withDataSource(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Data-Source', DATA_SOURCE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
