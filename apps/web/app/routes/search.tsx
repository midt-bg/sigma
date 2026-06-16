import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { count, money, plural } from '@sigma/shared';
import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, search } from '@sigma/db';
import type { SearchHit } from '@sigma/api-contract';
import type { Route } from './+types/search';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Callout, Chip, OwnershipChip } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta({ data }: Route.MetaArgs) {
  const q = data?.results.query ?? '';
  return [
    { title: q ? `Търсене: „${q}" — СИГМА` : 'Търсене — СИГМА' },
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
  const results = await search(context.cloudflare.env.DB, q);
  return { results };
}

const KIND_LABEL: Record<string, string> = {
  authority: 'институция',
  company: 'компания',
  contract: 'договор',
};

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

function exceptionBadge(hit: SearchHit): ReactNode {
  if (hit.kind !== 'company') return null;
  if (hit.isConsortium) return <Chip>Обединение (ДЗЗД)</Chip>;
  if (hit.hasEik === false) return <Chip>без ЕИК</Chip>;
  return null;
}

function renderName(hit: SearchHit, re: RegExp | null): ReactNode {
  const badge = exceptionBadge(hit);
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

function companyMeta(hit: SearchHit, re: RegExp | null): ReactNode {
  const parts: ReactNode[] = [];
  if (hit.ident) {
    parts.push(
      <>
        ЕИК <span className="mono">{hit.ident}</span>
      </>,
    );
  }
  if (hit.isConsortium && hit.memberCount != null) {
    parts.push(`${count(hit.memberCount)} ${plural(hit.memberCount, 'участник', 'участника')}`);
  }
  if (hit.subtitle) parts.push(highlight(hit.subtitle, re));
  return joinMeta(parts);
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { results } = loaderData;
  const tokens = normalizedTerms(results.query, MAX_HIGHLIGHT_TOKENS);
  const highlightRe =
    tokens.length > 0 ? new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'giu') : null;
  const hasQuery = results.query.trim().length > 0;

  // What the search covers — a description, shown as the lede on the empty-query and no-results
  // states (never as a claim that matches were found). On a query that did match, the lede leads
  // with the result line instead.
  const coverage =
    'Търси из имената на институции и компании, предметите и номерата на договорите и УНП на преписките.';
  const lede =
    hasQuery && !results.empty ? 'Има съвпадения сред институции, компании и договори.' : coverage;
  // On the empty-query / no-results states no result <section> (each an h2) renders, so the Callout's
  // h3 would follow the h1 directly — an h1→h3 skip. Emit a preceding h2 in that case.
  const hasResults = results.groups.some((g) => g.total > 0);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: hasQuery ? `Търсене: „${results.query}"` : 'Търсене' },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker="Резултати от търсене"
          title={hasQuery ? results.query : 'Търсене'}
          lede={lede}
        />

        {hasQuery && results.empty && (
          <p className="muted">
            Нищо не намерихме за „{results.query}". Пробвай с име, ЕИК или УНП.
          </p>
        )}

        {results.groups
          .filter((g) => g.total > 0)
          .map((g) => (
            <section className="results-group" key={g.kind} aria-labelledby={`r-${g.kind}`}>
              <div className="head">
                <h2 id={`r-${g.kind}`}>{g.label}</h2>
                <span className="count">
                  {g.total > g.hits.length
                    ? `над ${count(g.hits.length)} от ${count(g.total)}`
                    : count(g.total)}{' '}
                  {plural(g.total, 'съвпадение', 'съвпадения')}
                  {g.moreHref && (
                    <>
                      {' '}
                      · <Link to={g.moreHref}>виж всички</Link>
                    </>
                  )}
                </span>
              </div>
              {g.hits.map((h) => (
                <Link to={h.href} className="result" key={h.slug + h.title}>
                  <span className="kind">{KIND_LABEL[h.kind]}</span>
                  <span>
                    <p className="name">{renderName(h, highlightRe)}</p>
                    <p className="meta">
                      {h.kind === 'contract' ? (
                        <>
                          {h.ident && (
                            <>
                              УНП <span className="mono">{highlight(h.ident, highlightRe)}</span>{' '}
                              ·{' '}
                            </>
                          )}
                          {highlight(h.subtitle, highlightRe)}
                        </>
                      ) : (
                        companyMeta(h, highlightRe)
                      )}
                    </p>
                  </span>
                  <span className="amt">
                    <span className="num">{h.amountEur != null ? money(h.amountEur) : '—'}</span>
                    <span className="lab">{h.amountLabel}</span>
                  </span>
                </Link>
              ))}
            </section>
          ))}

        {!hasResults && <h2 className="sr-only">Помощ при търсене</h2>}
        <Callout title="Съвети за търсене">
          <ul className="tips-list">
            <li>
              Въведи <strong>УНП</strong> като <code>00044-2023-0018</code> или фрагмент от него.
            </li>
            <li>
              Въведи <strong>ЕИК</strong> като <code>103267194</code> — получаваш профил на
              компанията.
            </li>
            <li>
              Главни и малки букви, както и ударенията, нямат значение. Кирилица и латиница се
              разпознават еднакво.
            </li>
            <li>
              Търси се по начало на дума — <code>стр</code> намира „<u>стр</u>оителство" и „
              <u>Стр</u>абаг".
            </li>
          </ul>
        </Callout>
      </main>
    </>
  );
}
