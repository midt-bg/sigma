import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { money } from '@sigma/shared';
import { search } from '@sigma/db';
import type { Route } from './+types/search';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Callout, Chip } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta({ data }: Route.MetaArgs) {
  const q = data?.results.query ?? '';
  return [
    { title: q ? `Търсене: „${q}" — Сигма` : 'Търсене — Сигма' },
    { name: 'robots', content: 'noindex' },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(300) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
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
function highlight(text: string | null, tokens: string[]): ReactNode {
  if (!text || tokens.length === 0) return text;
  const re = new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'giu');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { results } = loaderData;
  const tokens = (results.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
  const hasQuery = results.query.trim().length > 0;

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
          lede="Намерени са съвпадения в институции, компании и договори. Търсенето претърсва имена на институции и компании, предмети на договори, номера на договори и УНП на преписки."
        />

        {hasQuery && results.empty && (
          <p className="muted">Няма съвпадения за „{results.query}". Опитай с име, ЕИК или УНП.</p>
        )}

        {results.groups
          .filter((g) => g.total > 0)
          .map((g) => (
            <section className="results-group" key={g.kind} aria-labelledby={`r-${g.kind}`}>
              <div className="head">
                <h2 id={`r-${g.kind}`}>{g.label}</h2>
                <span className="count">
                  {g.total > g.hits.length ? `над ${g.hits.length} от ${g.total}` : `${g.total}`}{' '}
                  съвпадения
                </span>
              </div>
              {g.hits.map((h) => (
                <Link to={h.href} className="result" key={h.slug + h.title}>
                  <span className="kind">{KIND_LABEL[h.kind]}</span>
                  <span>
                    <p className="name">{highlight(h.title, tokens)}</p>
                    <p className="meta">
                      {h.kind === 'contract' ? (
                        <>
                          {h.ident && (
                            <>
                              УНП <span className="mono">{highlight(h.ident, tokens)}</span> ·{' '}
                            </>
                          )}
                          {highlight(h.subtitle, tokens)}
                        </>
                      ) : (
                        <>
                          {h.ident && (
                            <>
                              ЕИК <span className="mono">{h.ident}</span>
                            </>
                          )}
                          {h.ident && h.subtitle && ' · '}
                          {h.subtitle && highlight(h.subtitle, tokens)}
                          {h.kind === 'company' && (
                            <>
                              {' '}
                              <Chip>{KIND_LABEL[h.kind]}</Chip>
                            </>
                          )}
                        </>
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

        <Callout title="Съвети за търсене">
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              Въведи <strong>УНП</strong> като <code>00044-2023-0018</code> или фрагмент от него.
            </li>
            <li>
              Въведи <strong>ЕИК</strong> като <code>103267194</code> — получаваш профил на
              компанията.
            </li>
            <li>
              Главни/малки букви и ударения нямат значение; кирилица и латиница се обработват
              еднакво в рамките на писмеността.
            </li>
            <li>
              Думите се търсят на принципа „начало на дума" — <code>стр</code> намира „<u>стр</u>
              оителство", „<u>Стр</u>абаг".
            </li>
          </ul>
        </Callout>
      </main>
    </>
  );
}
