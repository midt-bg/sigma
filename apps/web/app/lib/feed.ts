import type { ContractListItem } from '@sigma/api-contract';
import { date, money } from '@sigma/shared';

// RSS 2.0 for the entity profile feeds ("следи тази институция/фирма" without an account).
// Hand-rolled on purpose: the format is tiny, the itemset is capped at one page, and every value
// passes through xmlEscape - a templating dependency would be more surface than the format itself.

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// Control characters that are NOT legal in XML 1.0 even when entity-escaped: everything below U+0020
// except TAB (U+0009), LF (U+000A) and CR (U+000D). A stray one in a source subject/name would make
// the whole feed invalid XML and strict readers reject it, so drop them before escaping (review
// ydimitrof). There is no meaningful replacement — they carry no display value.
const XML_INVALID_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function xmlEscape(value: string): string {
  return value.replace(XML_INVALID_CONTROL, '').replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** 'YYYY-MM-DD' -> RFC 822 (RSS pubDate); null for absent or malformed dates. */
export function rssDate(day: string | null): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t).toUTCString();
}

export interface RssItem {
  title: string;
  /** Absolute URL; doubles as the permalink <guid>. */
  link: string;
  description: string;
  pubDate: string | null;
}

/**
 * One feed item per contract. `counterparty` picks the side the feed's reader does NOT follow:
 * an authority feed lists winners ('bidder'), a company feed lists buyers ('authority').
 */
export function contractRssItem(
  item: ContractListItem,
  counterparty: 'bidder' | 'authority',
  origin: string,
): RssItem {
  const other = counterparty === 'bidder' ? item.bidderDisplayName : item.authorityName;
  const value = item.valueEur != null ? money(item.valueEur) : 'без обявена стойност';
  const parts = [
    `${counterparty === 'bidder' ? 'Изпълнител' : 'Възложител'}: ${other}`,
    `Стойност: ${value}`,
    item.signedAt ? `Подписан: ${date(item.signedAt)}` : null,
    `Процедура: ${item.procedureLabel}`,
  ].filter((p): p is string => p !== null);
  return {
    title: `${item.subject} - ${other}`,
    link: `${origin}/contracts/${item.id}`,
    description: parts.join(' · '),
    // Fall back to publishedAt when there is no signing date, matching the query's
    // `ORDER BY COALESCE(signed_at, published_at)`: an item positioned as "new" by publish date must
    // carry a <pubDate> so readers can order it, and the channel pubDate stays the true newest (review
    // ydimitrof). `??` (not `||`) is deliberate: it mirrors SQL COALESCE, which treats an empty string
    // as PRESENT (only NULL falls through). Real data has NULL signed_at, so the two never disagree —
    // and keeping the same rule here holds pubDate in sync with the row's ordering position.
    pubDate: rssDate(item.signedAt ?? item.publishedAt),
  };
}

export function rssFeed(opts: {
  title: string;
  description: string;
  /** Absolute URL of the HTML profile the feed mirrors. */
  siteLink: string;
  /** Absolute URL of the feed itself (atom:link rel="self"). */
  selfLink: string;
  items: RssItem[];
}): string {
  const items = opts.items
    .map((item) =>
      [
        '    <item>',
        `      <title>${xmlEscape(item.title)}</title>`,
        `      <link>${xmlEscape(item.link)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(item.link)}</guid>`,
        item.pubDate ? `      <pubDate>${xmlEscape(item.pubDate)}</pubDate>` : null,
        `      <description>${xmlEscape(item.description)}</description>`,
        '    </item>',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )
    .join('\n');
  // Channel-level pubDate is the newest item's date, computed as the MAX over all items rather than
  // trusting input order: rssFeed is generic and cannot enforce the caller's newest-first ordering, so
  // a future reordering must not silently yield a wrong channel <pubDate> (review ydimitrof). Still a
  // pure function of the data — no "now" timestamp anywhere (RFC-822 dates compare via Date.parse).
  const newest = opts.items.reduce<string | undefined>((max, item) => {
    if (!item.pubDate) return max;
    return max === undefined || Date.parse(item.pubDate) > Date.parse(max) ? item.pubDate : max;
  }, undefined);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(opts.title)}</title>`,
    `    <link>${xmlEscape(opts.siteLink)}</link>`,
    `    <description>${xmlEscape(opts.description)}</description>`,
    '    <language>bg</language>',
    newest ? `    <pubDate>${xmlEscape(newest)}</pubDate>` : null,
    `    <atom:link href="${xmlEscape(opts.selfLink)}" rel="self" type="application/rss+xml"/>`,
    items || null,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
