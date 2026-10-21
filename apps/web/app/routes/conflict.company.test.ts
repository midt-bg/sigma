import { describe, expect, it } from 'vitest';
import * as route from './conflict.company';

describe('/conflicts/company/:eik', () => {
  it('redirects a numeric ЕИК to the company page', () => {
    const res = route.loader({ params: { eik: '123456789' } } as never) as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/companies/123456789#declared-people');
  });

  it('answers a malformed id with a 404 through the site error page', () => {
    expect(() => route.loader({ params: { eik: 'abc' } } as never)).toThrow(Response);
    // A route without a component is a resource route: its thrown 404 would go out as bare text.
    expect(typeof route.default).toBe('function');
  });
});
