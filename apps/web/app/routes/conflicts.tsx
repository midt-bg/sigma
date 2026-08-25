import { Link, useSearchParams, data } from 'react-router';
import { count, money, plural } from '@sigma/shared';
import { getConflictLeaderboard, getDb } from '@sigma/db';
import type { Route } from './+types/conflicts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { Section, Callout, ShareBar, Chip } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  conflictHeadline,
  groupByPerson,
  officialHref,
  personFundsCell,
  type ConflictPersonRow,
} from '../lib/conflicts';
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

// All eligible published ownership links — self and family (ADR-0032). ~337 on the full 2015–2026 corpus
// after #279 (was ~98 pre-#279). Small enough to load whole and paginate in the client, so the summary totals
// the full set rather than one page. NB: hard ceiling 1000 — reserve ~3× today — switch to keyset LIMIT/OFFSET
// (see companies.tsx), or move grouping server-side, before the eligible set nears it.
const LEADERBOARD_MAX = 1000;
// Persons per page. The list is one row per PERSON (#287, groupByPerson), so pagination counts collapsed
// rows, not raw links — a person with N winners is one row, not N. The per-link corpus is ~337 (fewer
// persons), so a page is generous; the ceiling above still guards the loader's raw-link fetch.
const PER_PAGE = 100;

// Warn once the eligible set reaches this fraction of the ceiling — headroom to move grouping into SQL before
// truncation actually corrupts a per-person aggregate (niki #312 MEDIUM 2, „alert at 800").
const LEADERBOARD_WARN_AT = LEADERBOARD_MAX * 0.8;

export async function loader({ context }: Route.LoaderArgs) {
  const db = getDb(context.cloudflare.env);
  // Fetch ONE past the ceiling so truncation is DETECTABLE rather than silently capped. The leaderboard is
  // ordered by NEXUS strength, NOT by person, so a person's links are scattered across the ordering — a cut at
  // the ceiling can drop links for MANY persons at once, yielding partial per-person sums/companyCount and a
  // wrong `soleCompany`. That also means we CANNOT fix it by dropping a single trailing partial group (there
  // is no contiguous group to drop); the durable fix is grouping in SQL / server-side (tracked, LOW 3). Until
  // then the guard is loud observability: warn as the set nears the ceiling so an operator moves the grouping
  // BEFORE aggregates degrade, and slice deterministically so the render never depends on the +1 sentinel.
  const raw = await withDbRetry(() => getConflictLeaderboard(db, LEADERBOARD_MAX + 1));
  const truncated = raw.length > LEADERBOARD_MAX;
  const links = truncated ? raw.slice(0, LEADERBOARD_MAX) : raw;
  if (truncated) {
    console.warn(
      `conflicts leaderboard: eligible links exceed the ${LEADERBOARD_MAX} ceiling — per-person aggregates are now PARTIAL for boundary persons (sums/companyCount/soleCompany). Move grouping into SQL (MEDIUM 2 / LOW 3).`,
    );
  } else if (links.length >= LEADERBOARD_WARN_AT) {
    console.warn(
      `conflicts leaderboard: ${links.length}/${LEADERBOARD_MAX} eligible links — nearing the ceiling at which per-person aggregates degrade. Plan the SQL-side grouping before it is hit.`,
    );
  }
  // Never pin an empty render: just after a (re)ship the read can briefly return 0 rows while the write
  // propagates across D1; caching that for an hour + stale-while-revalidate is what made a refresh appear to
  // "lose" the data. Only cache once there is data to cache.
  return data(
    { links },
    { headers: { 'Cache-Control': links.length ? publicCache(3600) : 'no-store' } },
  );
}

// The six columns of the /conflicts person leaderboard (#287, plan §3.2). Rank is the corner badge on phone
// (isRank); the person name+institution becomes the card heading (isTitle); the funds cell is a right-aligned
// two-line lead-plus-„от" figure; the признаци chips live in a secondary column that drops on tablet.
function personColumns(startRank: number): Column<ConflictPersonRow>[] {
  return [
    { key: 'rank', header: '№', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'official',
      header: 'Длъжностно лице',
      isTitle: true,
      cell: (r) => (
        <>
          <Link to={officialHref(r.officialSlug)}>{r.official}</Link>
          {r.institution && (
            <>
              <br />
              <span className="small muted">{r.institution}</span>
            </>
          )}
          {/* Identity-free qualifier: a family-ONLY row must not read as the official's own stake (ADR-0032).
              The relative is never named and the relationship type never asserted — only that a свързано лице
              declared the stake. 'mixed' rows keep the own-stake framing (they DO have one); 'self' → nothing. */}
          {r.stakeKind === 'family' && (
            <>
              <br />
              <Chip>свързано лице</Chip>
            </>
          )}
        </>
      ),
    },
    {
      key: 'companies',
      header: 'Дружества',
      // The winner's name when the person is linked to exactly one; otherwise the distinct-ЕИК count. No
      // link — the person page (title column) is the way in; the winner names live there.
      cell: (r) =>
        r.companyCount === 1 && r.soleCompany ? r.soleCompany.company : count(r.companyCount),
    },
    { key: 'contracts', header: 'Договори', align: 'money', cell: (r) => count(r.contractCount) },
    {
      key: 'funds',
      header: 'Публични средства',
      align: 'money',
      // Leads with the conflict-window sum (the „по време на конфликта" figure) and keeps the total beneath as
      // „от <total>" — the same lead/total split fundsCellLabel encodes per link, here over the person's
      // per-ЕИК-deduped sums. When nothing was signed in the window there is no split: show only the total.
      cell: (r) => {
        const cell = personFundsCell(r);
        return (
          <>
            {cell.primary}
            {cell.total != null && (
              <>
                <br />
                <span className="small muted">от {cell.total}</span>
              </>
            )}
          </>
        );
      },
    },
    {
      key: 'signals',
      header: 'Признаци',
      secondary: true,
      // Restrained monochrome chips (no new colour): the two nexus signals, OR-ed across the person's links.
      cell: (r) => (
        <>
          {r.ownInstitution && <Chip>от собствената институция</Chip>}
          {r.ownInstitution && r.hasContemporaneous && ' '}
          {r.hasContemporaneous && <Chip>към момента на договор</Chip>}
        </>
      ),
    },
  ];
}

export default function Conflicts({ loaderData }: Route.ComponentProps) {
  const { links } = loaderData;
  const headline = conflictHeadline(links);
  const [sp] = useSearchParams();
  // Collapse per-relationship links into one row per PERSON, then paginate over ROWS (#287): a person with
  // three winners is one row, not three, so the page count and rank offset both count persons.
  const persons = groupByPerson(links);
  const pageCount = Math.max(1, Math.ceil(persons.length / PER_PAGE));
  const page = Math.min(Math.max(1, Math.floor(Number(sp.get('page')) || 1)), pageCount);
  const pageRows = persons.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const columns = personColumns(leaderboardRankOffset(page, PER_PAGE));
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
              <DataTable
                columns={columns}
                rows={pageRows}
                getKey={(r) => r.officialSlug}
                caption="Длъжностни лица с деклариран дял в компании изпълнители"
              />
              {pageCount > 1 && <Pagination nav={nav} pageSize={PER_PAGE} unit="лица" />}
            </Section>
          </>
        )}
      </main>
    </>
  );
}
