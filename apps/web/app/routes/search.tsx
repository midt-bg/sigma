import type { ReactNode } from 'react';
import { Link } from '../i18n/Link';
import { count, money, plural } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT, type TFunction } from '../i18n/t';
import { getLocale, type Locale } from '../i18n/locale';
import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, search } from '@sigma/db';
import type { SearchHit } from '@sigma/api-contract';
import type { Route } from './+types/search';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Callout, Chip, OwnershipChip } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta({ data, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  const q = data?.results.query ?? '';
  return [
    { title: q ? t('searchPage.metaTitleQuery', { query: q }) : t('searchPage.metaTitle') },
    { name: 'robots', content: 'noindex' },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(300) };
}

const MAX_HIGHLIGHT_TOKENS = 8;
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  k: 'к',
  m: 'м',
  t: 'т',
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
};
const CYRILLIC = /[\p{Script=Cyrillic}]/u;

function deHomoglyph(q: string): string {
  return q.replace(/[aceopxykmtABCEHKMOPTX]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
}

function normalizedTerms(q: string, limit: number): string[] {
  const terms =
    q
      .slice(0, MAX_QUERY_CHARS)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.slice(0, limit).map((t) => (CYRILLIC.test(t) ? deHomoglyph(t) : t));
}

function cappedQuery(q: string): string {
  return normalizedTerms(q, MAX_QUERY_TOKENS).join(' ');
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const q = cappedQuery(new URL(request.url).searchParams.get('q') ?? '');
  const results = await search(context.cloudflare.env.DB, q, getLocale(request));
  return { results };
}

function kindLabel(kind: string, t: TFunction): string {
  if (kind === 'authority') return t('searchPage.kindAuthority');
  if (kind === 'company') return t('searchPage.kindCompany');
  if (kind === 'contract') return t('searchPage.kindContract');
  return kind;
}

// Group heading per entity kind — keyed on the stable `kind` token, never the DB's Bulgarian label.
function groupLabel(kind: string, t: TFunction): string {
  if (kind === 'authority') return t('searchPage.groupAuthority');
  if (kind === 'company') return t('searchPage.groupCompany');
  if (kind === 'contract') return t('searchPage.groupContract');
  return kind;
}

// Per-hit amount caption per entity kind — keyed on `kind`, never the DB's Bulgarian amountLabel.
function amountLabel(kind: string, t: TFunction): string {
  if (kind === 'authority') return t('searchPage.amountAuthority');
  if (kind === 'company') return t('searchPage.amountCompany');
  if (kind === 'contract') return t('searchPage.amountContract');
  return '';
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wrap query-token matches in <mark>, React-safely (no dangerouslySetInnerHTML).
function highlight(text: string | null, re: RegExp | null): ReactNode {
  if (!text || !re) return text;
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

function renderTitle(hit: SearchHit, re: RegExp | null) {
  return highlight(hit.title, re);
}

function exceptionBadge(hit: SearchHit, t: TFunction): ReactNode {
  if (hit.kind !== 'company') return null;
  if (hit.isConsortium) return <Chip>{t('searchPage.consortium')}</Chip>;
  if (hit.hasEik === false) return <Chip>{t('searchPage.noEik')}</Chip>;
  return null;
}

function renderName(hit: SearchHit, re: RegExp | null, t: TFunction): ReactNode {
  const badge = exceptionBadge(hit, t);
  const ownershipBadge =
    hit.kind === 'company' && hit.ownershipKind ? <OwnershipChip kind={hit.ownershipKind} /> : null;
  return (
    <>
      {badge}
      {badge && ' '}
      {ownershipBadge}
      {ownershipBadge && ' '}
      {renderTitle(hit, re)}
    </>
  );
}

function joinMeta(parts: ReactNode[]): ReactNode {
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}

function companyMeta(hit: SearchHit, re: RegExp | null, t: TFunction, locale: Locale): ReactNode {
  const parts: ReactNode[] = [];
  if (hit.ident) {
    parts.push(
      <>
        {t('searchPage.eikLabel')} <span className="mono">{hit.ident}</span>
      </>,
    );
  }
  if (hit.isConsortium && hit.memberCount != null) {
    parts.push(
      `${count(hit.memberCount, locale)} ${plural(
        hit.memberCount,
        t('searchPage.members_one'),
        t('searchPage.members_many'),
        locale,
      )}`,
    );
  }
  if (hit.subtitle) parts.push(highlight(hit.subtitle, re));
  return joinMeta(parts);
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { results } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const tokens = normalizedTerms(results.query, MAX_HIGHLIGHT_TOKENS);
  const highlightRe =
    tokens.length > 0 ? new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'giu') : null;
  const hasQuery = results.query.trim().length > 0;

  // What the search covers — a description, shown as the lede on the empty-query and no-results
  // states (never as a claim that matches were found). On a query that did match, the lede leads
  // with the result line instead.
  const coverage = t('searchPage.coverage');
  const lede = hasQuery && !results.empty ? t('searchPage.ledeMatches') : coverage;
  // On the empty-query / no-results states no result <section> (each an h2) renders, so the Callout's
  // h3 would follow the h1 directly — an h1→h3 skip. Emit a preceding h2 in that case.
  const hasResults = results.groups.some((g) => g.total > 0);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('searchPage.breadcrumbHome'), to: '/' },
          {
            label: hasQuery
              ? t('searchPage.breadcrumbSearchQuery', { query: results.query })
              : t('searchPage.breadcrumbSearch'),
          },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('searchPage.kicker')}
          title={hasQuery ? results.query : t('searchPage.title')}
          lede={lede}
        />

        {hasQuery && results.empty && (
          <p className="muted">{t('searchPage.empty', { query: results.query })}</p>
        )}

        {results.groups
          .filter((g) => g.total > 0)
          .map((g) => (
            <section className="results-group" key={g.kind} aria-labelledby={`r-${g.kind}`}>
              <div className="head">
                <h2 id={`r-${g.kind}`}>{groupLabel(g.kind, t)}</h2>
                <span className="count">
                  {g.total > g.hits.length
                    ? t('searchPage.overOf', {
                        shown: count(g.hits.length, locale),
                        total: count(g.total, locale),
                      })
                    : count(g.total, locale)}{' '}
                  {plural(
                    g.total,
                    t('searchPage.matches_one'),
                    t('searchPage.matches_many'),
                    locale,
                  )}
                  {g.moreHref && (
                    <>
                      {' '}
                      · <Link to={g.moreHref}>{t('searchPage.viewAll')}</Link>
                    </>
                  )}
                </span>
              </div>
              {g.hits.map((h) => (
                <Link to={h.href} className="result" key={h.slug + h.title}>
                  <span className="kind">{kindLabel(h.kind, t)}</span>
                  <span>
                    <p className="name">{renderName(h, highlightRe, t)}</p>
                    <p className="meta">
                      {h.kind === 'contract' ? (
                        <>
                          {h.ident && (
                            <>
                              {t('searchPage.unpLabel')}{' '}
                              <span className="mono">{highlight(h.ident, highlightRe)}</span> ·{' '}
                            </>
                          )}
                          {highlight(h.subtitle, highlightRe)}
                        </>
                      ) : (
                        companyMeta(h, highlightRe, t, locale)
                      )}
                    </p>
                  </span>
                  <span className="amt">
                    <span className="num">
                      {h.amountEur != null ? money(h.amountEur, locale) : '—'}
                    </span>
                    <span className="lab">{amountLabel(h.kind, t)}</span>
                  </span>
                </Link>
              ))}
            </section>
          ))}

        {!hasResults && <h2 className="sr-only">{t('searchPage.help')}</h2>}
        <Callout title={t('searchPage.tipsTitle')}>
          <ul className="tips-list">
            <li>
              {t('searchPage.tipUnpPre')} <strong>{t('searchPage.tipUnpStrong')}</strong>{' '}
              {t('searchPage.tipUnpPost')} <code>00044-2023-0018</code> {t('searchPage.tipUnpOr')}
            </li>
            <li>
              {t('searchPage.tipEikPre')} <strong>{t('searchPage.tipEikStrong')}</strong>{' '}
              {t('searchPage.tipEikPost')} <code>103267194</code> {t('searchPage.tipEikResult')}
            </li>
            <li>{t('searchPage.tipCase')}</li>
            <li>
              {t('searchPage.tipPrefixPre')} <code>{t('searchPage.tipPrefixStr1')}</code>{' '}
              {t('searchPage.tipPrefixMid')}
              <u>{t('searchPage.tipPrefixStr1')}</u>
              {t('searchPage.tipPrefixWord1')}
              <u>{t('searchPage.tipPrefixStr2')}</u>
              {t('searchPage.tipPrefixWord2')}
            </li>
          </ul>
        </Callout>
      </main>
    </>
  );
}
