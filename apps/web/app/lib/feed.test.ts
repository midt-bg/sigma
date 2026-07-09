import { describe, expect, it } from 'vitest';
import type { ContractListItem } from '@sigma/api-contract';
import { contractRssItem, rssDate, rssFeed, xmlEscape } from './feed';

function item(overrides: Partial<ContractListItem> = {}): ContractListItem {
  return {
    id: 'e:UNP-1:2:eik:111111111',
    subject: 'Доставка на техника',
    unp: 'UNP-1',
    sectorCode: '30',
    euFunded: false,
    isConsortium: false,
    authoritySlug: '123456789',
    authorityName: 'Община Пример',
    bidderSlug: '111111111',
    bidderName: 'Фирма ЕООД',
    bidderDisplayName: 'Фирма ЕООД',
    bidderKind: 'company',
    procedureLabel: 'Открита процедура',
    signedAt: '2026-05-15',
    publishedAt: null,
    bidsReceived: 3,
    valueEur: 12345.67,
    ...overrides,
  };
}

describe('xmlEscape', () => {
  it('escapes the five XML special characters', () => {
    expect(xmlEscape(`<a & "b" & 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &amp; &apos;c&apos;&gt;');
  });
  it('passes ordinary Bulgarian text through unchanged', () => {
    expect(xmlEscape('Община „Пример“ - договори')).toBe('Община „Пример“ - договори');
  });
});

describe('rssDate', () => {
  it('renders an ISO day as RFC 822', () => {
    expect(rssDate('2026-05-15')).toBe('Fri, 15 May 2026 00:00:00 GMT');
  });
  it('returns null for null, malformed, and impossible dates', () => {
    expect(rssDate(null)).toBeNull();
    expect(rssDate('')).toBeNull();
    expect(rssDate('15.05.2026')).toBeNull();
    expect(rssDate('2026-13-45')).toBeNull();
  });
});

describe('contractRssItem', () => {
  it('builds an authority-feed item around the winning bidder', () => {
    const rss = contractRssItem(item(), 'bidder', 'https://sigma.midt.bg');
    expect(rss.title).toBe('Доставка на техника - Фирма ЕООД');
    expect(rss.link).toBe('https://sigma.midt.bg/contracts/e:UNP-1:2:eik:111111111');
    expect(rss.description).toContain('Изпълнител: Фирма ЕООД');
    expect(rss.description).toContain('Подписан: 15.05.2026');
    expect(rss.description).toContain('Процедура: Открита процедура');
    expect(rss.pubDate).toBe('Fri, 15 May 2026 00:00:00 GMT');
  });

  it('builds a company-feed item around the buying authority', () => {
    const rss = contractRssItem(item(), 'authority', 'https://sigma.midt.bg');
    expect(rss.title).toBe('Доставка на техника - Община Пример');
    expect(rss.description).toContain('Възложител: Община Пример');
  });

  it('handles missing value and missing signing date', () => {
    const rss = contractRssItem(item({ valueEur: null, signedAt: null }), 'bidder', 'https://x.bg');
    expect(rss.description).toContain('Стойност: без обявена стойност');
    expect(rss.description).not.toContain('Подписан:');
    expect(rss.pubDate).toBeNull();
  });

  it('falls back to publishedAt for pubDate when there is no signing date', () => {
    // Mirrors the query's ORDER BY COALESCE(signed_at, published_at): an item ordered by publish date
    // must still carry a <pubDate> so readers can sort it. The description omits „Подписан:" (no signing).
    const rss = contractRssItem(
      item({ signedAt: null, publishedAt: '2026-05-10' }),
      'bidder',
      'https://x.bg',
    );
    expect(rss.pubDate).toBe('Sun, 10 May 2026 00:00:00 GMT');
    expect(rss.description).not.toContain('Подписан:');
  });
});

describe('rssFeed', () => {
  const opts = {
    title: 'Община <Пример> - нови договори',
    description: 'Най-новите договори & анекси',
    siteLink: 'https://sigma.midt.bg/authorities/123456789',
    selfLink: 'https://sigma.midt.bg/authorities/123456789.rss',
    items: [
      contractRssItem(
        item({ subject: 'А/Б "проект" <спешен>' }),
        'bidder',
        'https://sigma.midt.bg',
      ),
      contractRssItem(item({ signedAt: null, valueEur: null }), 'bidder', 'https://sigma.midt.bg'),
    ],
  };

  it('escapes user-controlled text everywhere it lands', () => {
    const xml = rssFeed(opts);
    expect(xml).toContain('<title>Община &lt;Пример&gt; - нови договори</title>');
    expect(xml).toContain('Най-новите договори &amp; анекси');
    expect(xml).toContain('А/Б &quot;проект&quot; &lt;спешен&gt;');
    expect(xml).not.toMatch(/<спешен>/);
  });

  it('links the feed to itself and to the profile', () => {
    const xml = rssFeed(opts);
    expect(xml).toContain(
      '<atom:link href="https://sigma.midt.bg/authorities/123456789.rss" rel="self" type="application/rss+xml"/>',
    );
    expect(xml).toContain('<link>https://sigma.midt.bg/authorities/123456789</link>');
  });

  it('uses the contract URL as a permalink guid and skips pubDate for undated items', () => {
    const xml = rssFeed(opts);
    expect(xml).toContain(
      '<guid isPermaLink="true">https://sigma.midt.bg/contracts/e:UNP-1:2:eik:111111111</guid>',
    );
    expect(xml.match(/<pubDate>/g)).toHaveLength(2); // channel + the one dated item
  });

  it('stays deterministic: channel pubDate is the newest item date, no wall clock', () => {
    const xml = rssFeed(opts);
    expect(xml).toContain('<pubDate>Fri, 15 May 2026 00:00:00 GMT</pubDate>');
    expect(rssFeed(opts)).toBe(xml);
  });

  it('renders a valid empty channel when the entity has no contracts', () => {
    const xml = rssFeed({ ...opts, items: [] });
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
    expect(xml).not.toContain('<pubDate>');
  });

  it('channel pubDate is the MAX item date, not the first — even if items are mis-ordered', () => {
    // rssFeed cannot enforce the caller's newest-first order, so it computes the max defensively.
    const older = contractRssItem(item({ signedAt: '2026-01-10' }), 'bidder', 'https://x.bg');
    const newer = contractRssItem(item({ signedAt: '2026-08-20' }), 'bidder', 'https://x.bg');
    // Newest is SECOND in the array → a `find`-first would wrongly pick the older one. Anchor on the
    // channel's <language> line (only the channel pubDate follows it) to target the channel, not items.
    const xml = rssFeed({ ...opts, items: [older, newer] });
    expect(xml).toContain(
      '<language>bg</language>\n    <pubDate>Thu, 20 Aug 2026 00:00:00 GMT</pubDate>',
    );
  });
});
