import { describe, expect, it } from 'vitest';
import { loader } from './robots';

const robots = async (url: string) =>
  (loader({ request: new Request(url) } as Parameters<typeof loader>[0]) as Response).text();

describe('robots.txt', () => {
  it('opens the production site to crawlers and names its sitemap', async () => {
    const body = await robots('https://sigma.midt.bg/robots.txt');
    expect(body.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
    expect(body.endsWith('\nSitemap: https://sigma.midt.bg/sitemap.xml\n')).toBe(true);
  });

  it('keeps crawlers off filtered lists, searches, exports and the machine twins of pages', async () => {
    const rules = (await robots('https://sigma.midt.bg/robots.txt')).split('\n');
    for (const rule of [
      'Disallow: /*?',
      'Disallow: /search',
      'Disallow: /*.csv',
      'Disallow: /*.data',
      'Disallow: /contracts/*.json',
    ])
      expect(rules, rule).toContain(rule);
  });

  it('leaves every sitemap reachable, the paged one included', async () => {
    const rules = (await robots('https://sigma.midt.bg/robots.txt')).split('\n');
    // The longest matching rule decides: the Allow below is longer than the query rule it overrides.
    const allow = 'Allow: /sitemap-contracts.xml?';
    expect(rules).toContain(allow);
    expect(allow.length).toBeGreaterThan('Disallow: /*?'.length);
  });

  it('closes stage and dev, without a sitemap to follow', async () => {
    for (const url of [
      'https://sigma-stage.midt.bg/robots.txt',
      'https://sigma-dev.cf-midt.workers.dev/robots.txt',
    ])
      expect(await robots(url), url).toBe('User-agent: *\nDisallow: /\n');
  });
});
