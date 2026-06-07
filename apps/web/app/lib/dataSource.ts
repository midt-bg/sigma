export const DATA_SOURCE = 'AOP/CAIS EOP open-data (storage.eop.bg)';
export const DATA_SOURCE_LICENSE =
  'Източник (CC-BY 4.0): АОП / ЦАИС ЕОП — отворени данни (storage.eop.bg)';

export function withDataSource(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Data-Source', DATA_SOURCE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
