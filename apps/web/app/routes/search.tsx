import type { ReactNode } from 'react';
import { Form, Link } from 'react-router';
import { count, MAX_QUERY_CHARS, money, plural, searchTokens } from '@sigma/shared';
import { CYRILLIC, MAX_QUERY_TOKENS, deHomoglyph, search, getDb } from '@sigma/db';
import type { SearchHit } from '@sigma/api-contract';
import type { Route } from './+types/search';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { kindLabel } from '../lib/search-labels';
import { Abbr, Callout, Chip, OwnershipChip } from '../components/ui';
import { cached } from '../lib/cache';
import { personName } from '../lib/person-name';

export function meta({ data }: Route.MetaArgs) {
  const q = data?.results.query ? data.typed : '';
  return [
    { title: q ? `Търсене: „${q}“ — СИГМА` : 'Търсене — СИГМА' },
    { name: 'robots', content: 'noindex' },
  ];
}

export const headers = cached(300);

const MAX_HIGHLIGHT_TOKENS = 8;

// Share the FTS tokenizer with @sigma/db and the in-table search so all three agree on what counts as
// a searchable term (incl. the ≥MIN_QUERY_TOKEN_CHARS filter — single chars no longer reach MATCH).
// deHomoglyph is layered on top and is length-preserving, so it doesn't disturb that filtering.
function normalizedTerms(q: string, limit: number): string[] {
  return searchTokens(q)
    .slice(0, limit)
    .map((t) => (CYRILLIC.test(t) ? deHomoglyph(t) : t));
}

function cappedQuery(q: string): string {
  return normalizedTerms(q, MAX_QUERY_TOKENS).join(' ');
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // What the visitor typed stays in the field and the heading; the normalised terms (lower-cased,
  // punctuation and one-letter words dropped, capped) are what is searched, and the page says so.
  const typed = (new URL(request.url).searchParams.get('q') ?? '').slice(0, MAX_QUERY_CHARS).trim();
  const results = await search(getDb(context.cloudflare.env), cappedQuery(typed));
  return { results, typed };
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
  return highlight(
    hit.kind === 'official' || hit.kind === 'person' ? personName(hit.title) : hit.title,
    re,
  );
}

// Search results are whole-card links; explanations remain on the destination profile.
function exceptionBadge(hit: SearchHit): ReactNode {
  if (hit.kind !== 'company') return null;
  if (hit.isConsortium) return <Chip explain={false}>съвместни изпълнители</Chip>;
  if (hit.hasEik === false) return <Chip explain={false}>без ЕИК</Chip>;
  return null;
}

function renderName(hit: SearchHit, re: RegExp | null): ReactNode {
  const badge = exceptionBadge(hit);
  const ownershipBadge =
    hit.kind === 'company' && hit.ownershipKind ? <OwnershipChip kind={hit.ownershipKind} /> : null;
  // A company that appears in the свързани-лица surface carries a trailing flag; the card links to the
  // company page, which lists the declared people (a nested <a> here would be invalid).
  const conflictBadge =
    hit.kind === 'company' && hit.hasConflict ? <Chip>свързани лица</Chip> : null;
  return (
    <>
      {badge}
      {badge && ' '}
      {ownershipBadge}
      {ownershipBadge && ' '}
      {renderTitle(hit, re)}
      {conflictBadge && ' '}
      {conflictBadge}
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
  const { results, typed } = loaderData;
  const tokens = normalizedTerms(results.query, MAX_HIGHLIGHT_TOKENS);
  const highlightRe =
    tokens.length > 0 ? new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'giu') : null;
  const hasQuery = results.query.trim().length > 0;
  // Shown when the searched terms differ from the typed text by more than letter case.
  const rewritten = hasQuery && typed.toLocaleLowerCase('bg') !== results.query;

  // What the search covers — a description, shown as the lede on the empty-query and no-results
  // states (never as a claim that matches were found). On a query that did match, the lede leads
  // with the result line instead.
  const coverage =
    'Търси из имената на институции, компании и лица, предметите и номерата на договорите и УНП на преписките.';
  const lede =
    hasQuery && !results.empty
      ? 'Резултатите са групирани по вид: лица, институции, компании и договори.'
      : coverage;
  // On the empty-query / no-results states no result <section> (each an h2) renders, so the Callout's
  // h3 would follow the h1 directly — an h1→h3 skip. Emit a preceding h2 in that case.
  const hasResults = results.groups.some((g) => g.total > 0);

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: hasQuery ? `Търсене: „${typed}“` : 'Търсене' },
        ]}
      />
      <main id="main">
        <PageHeader kicker="Резултати от търсене" title={hasQuery ? typed : 'Търсене'} lede={lede}>
          <Form method="get" className="page-search" role="search">
            <label htmlFor="page-query">
              Търси по име, <Abbr>ЕИК</Abbr>, договор или преписка
            </label>
            <div>
              <input id="page-query" type="search" name="q" defaultValue={typed} key={typed} />
              <button type="submit">Търси</button>
            </div>
          </Form>
        </PageHeader>

        {rewritten && <p className="muted">Търсено по думите: „{results.query}“.</p>}
        {!hasQuery && typed !== '' && <p className="muted">Въведи поне две букви или цифри.</p>}

        {hasQuery && results.empty && (
          <p className="muted">
            Нищо не намерихме за „{results.query}“. Пробвай с име, <Abbr>ЕИК</Abbr> или{' '}
            <Abbr>УНП</Abbr>.
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
                    ? `първите ${count(g.hits.length)} от ${count(g.total)}`
                    : count(g.total)}{' '}
                  {plural(g.total, 'съвпадение', 'съвпадения')}
                  {g.moreHref && (
                    <>
                      {' '}
                      ·{' '}
                      <Link to={g.moreHref}>
                        виж всички<span className="sr-only"> {g.label.toLowerCase()}</span>
                      </Link>
                    </>
                  )}
                </span>
              </div>
              {g.hits.map((h) => (
                <Link to={h.href} className="result" key={h.slug + h.title}>
                  <span className="kind">{kindLabel(h)}</span>
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
                  {h.kind !== 'person' && (
                    <span className="amt">
                      <span className="num">{h.amountEur != null ? money(h.amountEur) : '—'}</span>
                      <span className="lab">{h.amountLabel}</span>
                    </span>
                  )}
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
              Главни и малки букви, както и ударенията, нямат значение. Латинска буква в дума на
              кирилица (например „мoст“ с латинско „o“) се разпознава; дума изцяло на латиница се
              търси както е написана.
            </li>
            <li>
              Търси се по начало на дума — <code>стр</code> намира „<u>стр</u>оителство“ и „
              <u>Стр</u>абаг“.
            </li>
          </ul>
        </Callout>
      </main>
    </>
  );
}
