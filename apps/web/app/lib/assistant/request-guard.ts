// First-party request guard for the paid /assistant/chat endpoint (review #80, lyubomir-bozhinov).
//
// The route starts a paid BgGPT turn. Without an origin check, a cross-site page can make a victim's
// browser POST here with a CORS "simple" Content-Type (text/plain) — no preflight — spending a paid turn
// and the victim's per-IP budget under the victim's IP: CSRF → denial-of-wallet. Two cheap, layered
// checks block it without breaking the first-party dock (useChat posts same-origin JSON):
//   1. Content-Type must be application/json. A cross-origin fetch with application/json is NOT a simple
//      request, so the browser sends a preflight we never green-light; and a <form> POST cannot set
//      application/json. This is the load-bearing check.
//   2. Sec-Fetch-Site (sent by modern browsers) must not be an explicit cross-site/same-site context —
//      defence-in-depth where the browser provides it.
// Pure (header primitives in, decision out) so it is unit-testable without the Worker/SDK harness.

export interface FirstPartyRequest {
  method: string;
  contentType: string | null;
  secFetchSite: string | null;
}

export type FirstPartyRejection = { status: number; error: string };

/** Reject a non-first-party request to /assistant/chat, or null if it may proceed. */
export function firstPartyRejection(req: FirstPartyRequest): FirstPartyRejection | null {
  if (req.method !== 'POST') {
    return { status: 405, error: 'методът не е разрешен' };
  }
  // Reject an explicit cross-site / same-site browser context. Absent ⇒ non-browser client (still gated
  // by Content-Type below); `none` ⇒ direct navigation (no cross-site initiator).
  const sfs = req.secFetchSite;
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return { status: 403, error: 'заявка от друг произход не е разрешена' };
  }
  if (!(req.contentType ?? '').toLowerCase().includes('application/json')) {
    return { status: 415, error: 'изисква се Content-Type: application/json' };
  }
  return null;
}
