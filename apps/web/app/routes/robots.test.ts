import { fakeD1 } from '@sigma/test-support';
import { describe, expect, it } from 'vitest';
import { loader } from './robots';
import { loader as sitemapIndex } from './sitemap';
import { loader as contractSitemap } from './sitemap-contracts';

const origin = 'https://sigma.midt.bg';
const robots = (host = origin) =>
  loader({ request: new Request(`${host}/robots.txt`) } as Parameters<typeof loader>[0]).text();

function repOctets(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return /[\w.~-]/.test(char) ? char : encoded.toUpperCase();
  });
}

// Match the single wildcard group emitted by this route. REP rules are case-sensitive prefixes
// of the path plus query, with * and terminal $ as operators. The longest match wins, with Allow
// winning ties (RFC 9309 §2.2.2–3 and Google's robots.txt specification).
function canCrawl(body: string, target: string): boolean {
  const url = new URL(target, origin);
  const pathAndQuery = repOctets(url.href.slice(url.origin.length).split('#', 1)[0]!);
  let longestMatch = 0;
  let allowed = true;

  expect(body.match(/^user-agent:\s*\S+/gim)).toEqual(['User-agent: *']);
  for (const [, directive, rule] of body.matchAll(/^(Allow|Disallow):[ \t]*(\S+)/gm)) {
    const pattern = repOctets(rule!);
    const anchored = pattern.endsWith('$');
    const glob = anchored ? pattern.slice(0, -1) : pattern;
    const regex = glob
      .split('*')
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const length = pattern.length;
    if (
      length < longestMatch ||
      !new RegExp(`^${regex}${anchored ? '$' : ''}`).test(pathAndQuery)
    ) {
      continue;
    }
    allowed = directive === 'Allow' || (length === longestMatch && allowed);
    longestMatch = length;
  }
  return allowed;
}

describe('robots.txt', () => {
  it.each([
    '/companies?sector=45',
    '/%63ompanies?sector=45',
    '/authorities?page=2',
    '/contracts?year=2001',
    '/competition?top=50',
    '/flows?funding=eu',
    '/map?year=2001',
    '/network?center=a%3A000000000',
    '/trends?g=year',
  ])('excludes the public query variant %s and permits its landing page', async (target) => {
    const body = await robots();
    expect(canCrawl(body, target)).toBe(false);
    expect(canCrawl(body, new URL(target, origin).pathname)).toBe(true);
  });

  it.each([
    '/Companies?sector=45',
    '/C%6Fmpanies?sector=45',
    '/companies/?sector=45',
    '/companies%3Fsector=45',
    '/companies%3fsector=45?sector=72',
    '/persons/dGVzdA',
    '/persons/dGVzdA?view=profile&year=2001',
    '/persons/dGVzdA.data?view=profile&year=2001',
    '/conflicts?q=fixture',
    '/conflicts/link/self/dGVzdA/000000000/contracts.data',
    '/search?q=fixture',
    '/search.data?q=fixture',
    '/search/suggest?q=fixture',
    '/companies/000000000?ref=fixture',
    '/contracts/test-1?ref=fixture',
    '/companies.data?sector=45',
    '/authorities.csv',
    '/companies.csv?q=fixture',
    '/contracts.csv?year=2001',
    '/contracts/test-1.json?ref=fixture',
  ])('allows crawlers to read any noindex directive on %s', async (target) => {
    expect(canCrawl(await robots(), target)).toBe(true);
  });

  it('allows the sitemap index, each generated child and contract slugs with extension tokens', async () => {
    const body = await robots();
    const index = `${origin}/sitemap.xml`;
    expect(body.match(/^Sitemap: (\S+)$/gm)).toEqual([`Sitemap: ${index}`]);
    expect(canCrawl(body, index)).toBe(true);

    const { db, calls } = fakeD1([
      { when: 'SELECT contracts FROM home_totals', first: { contracts: 45_001 } },
      { when: 'SELECT as_of FROM home_totals', first: { as_of: null } },
      {
        when: 'FROM contracts',
        all: [{ id: 'c:e:TEST:fixture.csv.data.json?draft:_:test:1', rid: 45_001 }],
      },
    ]);
    const args = (url: string) => ({
      request: new Request(url),
      context: { cloudflare: { env: { DB: db } } },
    });
    const locations = (xml: string) =>
      Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]!);
    const indexResponse = await sitemapIndex(args(index) as Parameters<typeof sitemapIndex>[0]);
    const children = locations(await indexResponse.text());
    const pageTwo = `${origin}/sitemap-contracts.xml?p=2`;
    expect(children).toContain(pageTwo);
    for (const child of children) expect(canCrawl(body, child), child).toBe(true);

    const sitemap = contractSitemap(args(pageTwo) as Parameters<typeof contractSitemap>[0]);
    expect(sitemap.status).toBe(200);
    const contracts = locations(await sitemap.text());
    expect(contracts).toEqual([
      `${origin}/contracts/e:TEST:fixture.csv.data.json%3Fdraft:_:test:1`,
    ]);
    expect(canCrawl(body, contracts[0]!)).toBe(true);
    expect(
      calls.filter(({ sql }) => sql.includes('FROM contracts')).map(({ binds }) => binds),
    ).toEqual([[45_000, 90_000, 5_000]]);
  });

  it.each([
    'https://sigma-stage.midt.bg',
    'https://sigma-dev.cf-midt.workers.dev',
    'https://sigma.cf-midt.workers.dev',
  ])('closes %s to crawlers and omits sitemap discovery', async (host) => {
    const body = await robots(host);
    expect(body).not.toMatch(/^Sitemap:/im);
    expect(canCrawl(body, `${host}/`)).toBe(false);
    expect(canCrawl(body, `${host}/sitemap-contracts.xml?p=2`)).toBe(false);
    expect(canCrawl(body, `${host}/persons/dGVzdA.data`)).toBe(false);
  });
});
