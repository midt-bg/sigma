import { Link, useSearchParams, data } from 'react-router';
import { count, money, plural } from '@sigma/shared';
import { getConflictLeaderboard, getWithheldFamilyAggregate, getDb } from '@sigma/db';
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
import { privateOwnershipHeadline } from '../lib/conflicts';
import { withParams, leaderboardRankOffset, type PageNav } from '../lib/filters';

// Свързани лица — office-holders who declared their OWN private ownership stake in a procurement winner.
// Every row is a PUBLISHED, certainty-1.0 link from a person's own asset declaration, exact-matched to a
// winner. A close relative's stake is withheld from every named row (ADR-0030) and reported only as a
// nameless aggregate (getWithheldFamilyAggregate — scalars, no rows) alongside the leaderboard.
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

// All eligible published own-stake links. ~292 today; small enough to load whole and paginate in the
// client, so the summary totals the full set rather than one page. NB: hard ceiling 1000 — switch to
// keyset LIMIT/OFFSET (see companies.tsx) if the eligible set ever nears it.
const LEADERBOARD_MAX = 1000;
const PER_PAGE = 100;

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context.cloudflare.env);
  // The nameless close-relative aggregate rides alongside the leaderboard — scalars only, never a row, so
  // nothing re-identifiable reaches this loader payload (the public `.data` twin). ADR-0030.
  const [links, family] = await Promise.all([
    withDbRetry(() => getConflictLeaderboard(db, LEADERBOARD_MAX)),
    withDbRetry(() => getWithheldFamilyAggregate(db)),
  ]);
  // Never pin an empty render: just after a (re)ship the read can briefly return 0 rows while the write
  // propagates across D1; caching that for an hour + stale-while-revalidate is what made a refresh
  // appear to "lose" the data. Only cache once there is data to cache.
  // Cache once there is ANY signal to cache (named links OR the nameless family aggregate); an all-empty
  // read just after a (re)ship must not pin an empty page for an hour.
  return data(
    { links, family },
    {
      headers: {
        'Cache-Control': links.length || family.officialCount ? publicCache(3600) : 'no-store',
      },
    },
  );
}

export default function Conflicts({ loaderData }: Route.ComponentProps) {
  const { links, family } = loaderData;
  const headline = privateOwnershipHeadline(links);
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
              Длъжностни лица, декларирали <em>собствен дял</em> в компании изпълнители
            </>
          }
          lede="Длъжностни лица, декларирали собствен дял в дружество, спечелило обществена поръчка. Всяка връзка е точно съвпадение между собствената декларация на лицето и регистъра на изпълнителите — не оценка, а факт с посочен източник."
        />

        <Callout titleAs="h2" title="Как се извежда връзката — и какво не твърди">
          <p className="m-0">
            Основата са <strong>собствените декларации</strong> на лицата пред КПКОНПИ (публичен
            регистър). Името на декларираното дружество (с правната форма) се сравнява{' '}
            <strong>точно</strong> с името на изпълнител, спечелил поръчка — българските фирмени
            имена са национално уникални, затова точното съвпадение е един и същ субект. Показваме{' '}
            <strong>само 100% съвпадения</strong> и <strong>само собствен деклариран дял</strong> в
            дружества с ограничена отговорност (не служебни роли и не борсови акции). Дял,
            деклариран на <strong>свързано лице</strong> (напр. съпруг/а или дете),{' '}
            <strong>не се показва поименно</strong> в тази версия — само като общ брой (виж
            обобщението). Причината: картата назовава лицето, дружеството и ЕИК, а за еднолично
            дружество Търговският регистър сочи собственика с едно кликване, затова анонимност не
            може да се гарантира. Връзката означава деклариран интерес, а <strong>не</strong>{' '}
            нарушение или конфликт по закон. Сигнал за неточност:{' '}
            <Link to="/conflicts/methodology#contest">Методология → Поправки</Link>.
          </p>
        </Callout>

        {/* The nameless family aggregate must render even when there is NO published named link — it is then
            the ONLY signal we can show (todorkolev #226 — B2). Empty state only when BOTH are empty. */}
        {links.length === 0 && family.officialCount === 0 ? (
          <p className="muted">Все още няма публикувани връзки.</p>
        ) : (
          <>
            <FactsList
              label="Обобщение"
              rows={[
                ...(links.length > 0
                  ? [
                      {
                        term: 'Длъжностни лица с деклариран собствен дял',
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
                    ]
                  : []),
                // Count only — no € (B2): an exact euro sum is a money fingerprint that re-identifies the
                // relative. Suppressed below MIN_FAMILY_CELL officials upstream, so officialCount>0 here
                // already means a safe, above-threshold cell.
                ...(family.officialCount > 0
                  ? [
                      {
                        term: 'Дял на свързано лице (не се показва поименно)',
                        value: `${count(family.officialCount)} ${plural(family.officialCount, 'лице', 'лица')}`,
                        sub: (
                          <>
                            декларирали дял на близък в дружества изпълнители; показва се само броят
                            — <Link to="/conflicts/methodology#shown">защо</Link>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />

            {links.length > 0 && headline.totalEur > 0 && headline.contemporaneousEur > 0 && (
              <div className="case-mag conflict-headline-mag">
                <span className="case-mag-label">В декларирания период</span>
                <ShareBar ratio={headline.contemporaneousEur / headline.totalEur} warn />
                <span className="case-mag-figures">
                  <strong>{money(headline.contemporaneousEur)}</strong> от{' '}
                  {money(headline.totalEur)}
                </span>
              </div>
            )}

            {links.length > 0 && (
              <Section
                id="list"
                title="Деклариран дял в компании изпълнители"
                hint="Лица, декларирали собствен дял в дружество, спечелило поръчка. Подредени по силата на връзката: първо договори от собствената институция, после дял към момента на договора."
              >
                <ConflictCards
                  links={pageLinks}
                  startRank={leaderboardRankOffset(page, PER_PAGE)}
                  totalCount={links.length}
                  caption="Длъжностни лица с деклариран дял в компании изпълнители"
                />
                {pageCount > 1 && <Pagination nav={nav} pageSize={PER_PAGE} unit="връзки" />}
              </Section>
            )}
          </>
        )}
      </main>
    </>
  );
}
