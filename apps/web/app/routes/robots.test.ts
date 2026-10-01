import { describe, expect, it } from 'vitest';
import { loader } from './robots';

const robots = async (url: string) =>
  (loader({ request: new Request(url) } as Parameters<typeof loader>[0]) as Response).text();

describe('robots.txt', () => {
  it('opens the production site to crawlers and names its sitemap', async () => {
    expect(await robots('https://sigma.midt.bg/robots.txt')).toBe(
      'User-agent: *\nAllow: /\nSitemap: https://sigma.midt.bg/sitemap.xml\n',
    );
  });

  it('closes stage and dev, without a sitemap to follow', async () => {
    for (const url of [
      'https://sigma-stage.midt.bg/robots.txt',
      'https://sigma-dev.cf-midt.workers.dev/robots.txt',
    ])
      expect(await robots(url), url).toBe('User-agent: *\nDisallow: /\n');
  });
});
