export const DATA_SOURCE = 'AOP/TR via data.egov.bg';
export const DATA_SOURCE_LICENSE =
  'Източник (CC-BY 4.0): data.egov.bg / АОП / ЦАИС ЕОП (организация № 502)';

export function withDataSource(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Data-Source', DATA_SOURCE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
