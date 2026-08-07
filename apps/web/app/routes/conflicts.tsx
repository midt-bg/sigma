import { Link, useSearchParams, data } from 'react-router';
import { count, money, plural } from '@sigma/shared';
import { getConflictLeaderboard, getDb } from '@sigma/db';
import type { Route } from './+types/conflicts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { Section, Callout, ShareBar } from '../components/ui';
import { ConflictCards } from '../components/ConflictCards';
import { Pagination } from '../components/Pagination';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { conflictHeadline } from '../lib/conflicts';
import { withParams, leaderboardRankOffset, type PageNav } from '../lib/filters';

// Свързани лица — office-holders who declared a material ownership stake, their OWN or a close relative's, in
// a procurement winner. Every row is a PUBLISHED, certainty-1.0 link from the official's own asset declaration
// exact-matched to a winner. Family stakes surface identically to self stakes (ADR-0032, superseding ADR-0030)
// — but the relative is never named and the relationship type is never asserted (relation 'related' only).
export function meta({ matches }: Route.MetaArgs) {
  const tags = seoMeta({
    matches,
    path: '/conflicts',
    title: 'Свързани лица — СИГМА',
    description:
      'Длъжностни лица, декларирали дял в дружества, спечелили обществени поръчки. Само 100% съвпадения.',
  });
  // Names individuals: keep out of search indices until legal sign-off on going public (prod is live).
  tags.push({ name: 'robots', content: 'noindex' });
  return tags;
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return { 'Cache-Control': loaderHeaders.get('Cache-Control') ?? publicCache(3600) };
}

// All eligible published ownership links — self and family (ADR-0032). ~98 on the full 2015–2026 corpus
// (77 self + 21 family; the per-declaration-type divest fix recovered 23 true links, #226). Small enough to
// load whole and paginate in the client, so the summary totals the full set rather than one page. NB: hard
// ceiling 1000 — switch to keyset LIMIT/OFFSET (see companies.tsx) if the eligible set ever nears it.
const LEADERBOARD_MAX = 1000;
const PER_PAGE = 100;

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context.cloudflare.env);
  const links = await withDbRetry(() => getConflictLeaderboard(db, LEADERBOARD_MAX));
  // Never pin an empty render: just after a (re)ship the read can briefly return 0 rows while the write
  // propagates across D1; caching that for an hour + stale-while-revalidate is what made a refresh appear to
  // "lose" the data. Only cache once there is data to cache.
  return data(
    { links },
    { headers: { 'Cache-Control': links.length ? publicCache(3600) : 'no-store' } },
  );
}

export default function Conflicts({ loaderData }: Route.ComponentProps) {
  const { links } = loaderData;
  const headline = conflictHeadline(links);
  const [sp] = useSearchParams();
  const pageCount = Math.max(1, Math.ceil(links.length / PER_PAGE));
  const page = Math.min(Math.max(1, Math.floor(Number(sp.get('page')) || 1)), pageCount);
  const pageLinks = links.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const nav: PageNav = {
    page,
    pageCount,
    prevHref: page > 1 ? withParams(sp, { page: page - 1 }) : null,
    nextHref: page < pageCount ? withParams(sp, { page: page + 1 }) : null,
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Свързани лица' }]} />
      <main id="main">
        <PageHeader
          kicker="Свързани лица"
          title={
            <>
              Длъжностни лица, декларирали <em>дял</em> в компании изпълнители
            </>
          }
          lede="Длъжностни лица, декларирали дял — свой или на свързано лице — в дружество, спечелило обществена поръчка. Всяка връзка е точно съвпадение между декларацията на лицето и регистъра на изпълнителите — не оценка, а факт с посочен източник."
        />

        <Callout titleAs="h2" title="Как се извежда връзката — и какво не твърди">
          <p className="m-0">
            Основата са <strong>собствените декларации</strong> на лицата пред КПКОНПИ (публичен
            регистър). Името на декларираното дружество (с правната форма) се сравнява{' '}
            <strong>точно</strong> с името на изпълнител, спечелил поръчка — българските фирмени
            имена са национално уникални, затова точното съвпадение е един и същ субект. Показваме{' '}
            <strong>само 100% съвпадения</strong> на деклариран дял в дружества с ограничена
            отговорност (не служебни роли и не борсови акции). Показваме и дял, деклариран на{' '}
            <strong>свързано лице</strong> — наравно със собствения — защото декларацията съществува
            именно за да е видимо дали публични пари стигат до дружество, свързано с човек с власт
            над тези пари. <strong>Името на близкия не се показва и не се съхранява</strong>, а
            видът на връзката <strong>не се твърди</strong> — казваме само „свързано лице", не
            „съпруг" или „дете". Връзката означава деклариран интерес, а <strong>не</strong>{' '}
            нарушение или конфликт по закон. Повече:{' '}
            <Link to="/conflicts/methodology#shown">Методология → Какво показваме</Link>. Сигнал за
            неточност: <Link to="/conflicts/methodology#contest">Поправки</Link>.
          </p>
        </Callout>

        {links.length === 0 ? (
          <p className="muted">Все още няма публикувани връзки.</p>
        ) : (
          <>
            <FactsList
              label="Обобщение"
              rows={[
                {
                  term: 'Длъжностни лица с деклариран дял',
                  value: count(headline.officialCount),
                },
                {
                  term: 'Връзки към изпълнители',
                  value: `${count(headline.linkCount)} ${plural(headline.linkCount, 'връзка', 'връзки')}`,
                },
                {
                  term: 'Публични средства към техните дружества',
                  value: money(headline.totalEur),
                  sub: `сбор от всички договори на свързаните изпълнители; в т.ч. ${money(headline.contemporaneousEur)} по договори, сключени в декларирания период`,
                },
              ]}
            />

            {headline.totalEur > 0 && headline.contemporaneousEur > 0 && (
              <div className="case-mag conflict-headline-mag">
                <span className="case-mag-label">В декларирания период</span>
                <ShareBar ratio={headline.contemporaneousEur / headline.totalEur} warn />
                <span className="case-mag-figures">
                  <strong>{money(headline.contemporaneousEur)}</strong> от{' '}
                  {money(headline.totalEur)}
                </span>
              </div>
            )}

            <Section
              id="list"
              title="Деклариран дял в компании изпълнители"
              hint="Лица, декларирали дял — свой или на свързано лице — в дружество, спечелило поръчка. Подредени по силата на връзката: първо договори от собствената институция, после дял към момента на договора."
            >
              <ConflictCards
                links={pageLinks}
                startRank={leaderboardRankOffset(page, PER_PAGE)}
                totalCount={links.length}
                caption="Длъжностни лица с деклариран дял в компании изпълнители"
              />
              {pageCount > 1 && <Pagination nav={nav} pageSize={PER_PAGE} unit="връзки" />}
            </Section>
          </>
        )}
      </main>
    </>
  );
}
