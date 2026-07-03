import { describe, expect, it } from 'vitest';
import { firstPartyRejection } from './request-guard';

const ok = { method: 'POST', contentType: 'application/json', secFetchSite: 'same-origin' };

describe('firstPartyRejection', () => {
  it('allows a same-origin JSON POST (the first-party dock)', () => {
    expect(firstPartyRejection(ok)).toBeNull();
    expect(
      firstPartyRejection({ ...ok, contentType: 'application/json; charset=utf-8' }),
    ).toBeNull();
    expect(firstPartyRejection({ ...ok, secFetchSite: null })).toBeNull(); // non-browser client
    expect(firstPartyRejection({ ...ok, secFetchSite: 'none' })).toBeNull(); // direct navigation
  });

  it('rejects a cross-site POST before the paid loop (CSRF → denial-of-wallet, review #80)', () => {
    expect(firstPartyRejection({ ...ok, secFetchSite: 'cross-site' })?.status).toBe(403);
    expect(firstPartyRejection({ ...ok, secFetchSite: 'same-site' })?.status).toBe(403);
  });

  it('rejects a non-JSON Content-Type (blocks the text/plain simple-request CSRF bypass)', () => {
    // a cross-site simple POST / <form> can only send text/plain | urlencoded | multipart, never JSON
    expect(firstPartyRejection({ ...ok, contentType: 'text/plain' })?.status).toBe(415);
    expect(firstPartyRejection({ ...ok, contentType: null })?.status).toBe(415);
    expect(
      firstPartyRejection({ ...ok, contentType: 'application/x-www-form-urlencoded' })?.status,
    ).toBe(415);
  });

  it('rejects a non-POST method that would otherwise run the action', () => {
    expect(firstPartyRejection({ ...ok, method: 'PUT' })?.status).toBe(405);
    expect(firstPartyRejection({ ...ok, method: 'DELETE' })?.status).toBe(405);
  });
});
