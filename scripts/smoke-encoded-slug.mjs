#!/usr/bin/env node
// Deployment smoke test for issue #213 (percent-encoded contract slugs). The in-process tests
// (`apps/web/app/routes/contract.slug-decode.test.ts`) prove React Router decodes "%2F" correctly, but
// they cannot exercise the Cloudflare edge in front of the worker. By default Cloudflare preserves
// "%2F" (RFC 3986 — reserved characters are not decoded), so the fix works; the residual risk is a
// zone-specific URL-normalisation Transform Rule (`url_decode()`) that would decode "%2F"→"/" before the
// worker and silently reintroduce the 404. This script closes that gap with a REAL HTTP request against
// a deployed preview.
//
// Usage (run after deploying a preview):
//   PREVIEW_URL=https://<preview-host> node scripts/smoke-encoded-slug.mjs
//   PREVIEW_URL=https://<preview-host> SLUG='e:...%2F...' node scripts/smoke-encoded-slug.mjs
//
// Without SLUG it discovers a "/"-in-id contract from the sitemap (which routes through contractSlug,
// so those ids appear percent-encoded). Exits non-zero on failure so CI can gate a deploy on it.

const base = (process.env.PREVIEW_URL || process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error(
    '✘ PREVIEW_URL is required (env or first arg), e.g. https://sigma-preview.example.workers.dev',
  );
  process.exit(2);
}

async function discoverEncodedSlug() {
  const url = `${base}/sitemap-contracts.xml`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✘ Could not read ${url} (HTTP ${res.status}) to discover a test contract.`);
    return null;
  }
  const xml = await res.text();
  // Grab the first <loc> whose contract slug carries an encoded slash — that is exactly the #213 shape.
  const match = xml.match(/\/contracts\/([^<\s]*%2[fF][^<\s]*)/);
  return match ? match[1] : null;
}

const slug = process.env.SLUG || (await discoverEncodedSlug());
if (!slug) {
  console.error(
    '✘ No contract id containing "/" (%2F) found in the sitemap sample. Pass one explicitly with SLUG=... to smoke test, or confirm the corpus has AOP ids with "/".',
  );
  process.exit(3);
}
if (!/%2[fF]/.test(slug)) {
  console.error(`✘ SLUG "${slug}" does not contain %2F — nothing to test for #213.`);
  process.exit(3);
}

const target = `${base}/contracts/${slug}`;
const res = await fetch(target, {
  redirect: 'manual',
  headers: { 'User-Agent': 'sigma-smoke-213' },
});
console.log(`GET ${target}\n → HTTP ${res.status}`);

if (res.status !== 200) {
  console.error(
    `✘ FAIL: expected 200, got ${res.status}. The encoded slash (%2F) is likely being normalised to "/" ` +
      "before the worker (check the zone's URL normalisation / Transform Rules). Issue #213 would regress.",
  );
  process.exit(1);
}
console.log('✔ OK: a contract whose id contains "/" resolves via its %2F-encoded URL (HTTP 200).');
console.log(
  '  The Cloudflare edge preserves %2F to the worker on this deployment — #213 fix is effective.',
);
