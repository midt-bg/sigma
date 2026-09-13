import { Link, useSearchParams, data } from 'react-router';
import { count } from '@sigma/shared';
import { authorityIdFromSlug, getAuthorityName, getRelatedPersonRows, getDb } from '@sigma/db';
import type { Route } from './+types/conflicts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section, Callout, Chip } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import {
  conflictListFilters,
  filterConflictRows,
  groupDeclaredInstitutions,
  institutionOptions,
  officialHref,
  officialRole,
  personFundsCell,
  sortConflictRows,
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
      'Декларирани участия в дружества с обществени поръчки, включително доказани исторически връзки.',
  });
  // Names individuals: keep out of search indices until legal sign-off on going public (prod is live).
  tags.push({ name: 'robots', content: 'noindex' });
  return tags;
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return { 'Cache-Control': loaderHeaders.get('Cache-Control') ?? publicCache(3600) };
}

// Group and filter on the server. Only one page of canonical people reaches the browser.
const PER_PAGE = 100;

// `?authority=<ЕИК>` narrows the list to the officials whose declared-stake winners that body paid — the
// institution profile links here. A malformed value is ignored rather than failing the page; an ЕИК that
// names no institution is a 404, like every other slug on the site.
const AUTHORITY_SLUG = /^\d{9}(\d{4})?$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = getDb(context.cloudflare.env);
  const slug = new URL(request.url).searchParams.get('authority');
  let authority: { slug: string; name: string } | null = null;
  let authorityId: string | undefined;
  if (slug && AUTHORITY_SLUG.test(slug)) {
    const id = authorityIdFromSlug(slug);
    const name = await withDbRetry(() => getAuthorityName(db, id));
    if (name == null) throw new Response('Not Found', { status: 404 });
    authority = { slug, name };
    authorityId = id;
  }
  const sp = new URL(request.url).searchParams;
  const filters = conflictListFilters(sp);
  const everyone = (await withDbRetry(() => getRelatedPersonRows(db, authorityId))).map(
    ({ declaredOffices, ...row }) => ({
      ...row,
      declaredInstitutions: groupDeclaredInstitutions(declaredOffices),
    }),
  );
  const persons = sortConflictRows(filterConflictRows(everyone, filters), filters.sort);
  const pageCount = Math.max(1, Math.ceil(persons.length / PER_PAGE));
  const asked = Number(sp.get('page') || 1);
  const page = Math.min(pageCount, Number.isSafeInteger(asked) && asked > 0 ? asked : 1);
  const facets = {
    self: everyone.filter((r) => r.stakeKind !== 'family').length,
    family: everyone.filter((r) => r.stakeKind !== 'self').length,
    own: everyone.filter((r) => r.ownInstitution).length,
    window: everyone.filter((r) => r.hasContemporaneous).length,
    institutions: institutionOptions(everyone, filters.institutions),
  };
  return data(
    {
      authority,
      facets,
      page,
      pageCount,
      total: persons.length,
      pageRows: persons.slice((page - 1) * PER_PAGE, page * PER_PAGE),
      available: everyone.length,
    },
    { headers: { 'Cache-Control': everyone.length ? publicCache(3600) : 'no-store' } },
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
          {(r.declaredInstitutions?.length ?? 0) > 0 ? (
            <div className="person-institutions">
              <span className="small muted">Институции в декларациите</span>
              <ul>
                {r.declaredInstitutions!.map((i) => (
                  <li key={i.institution}>
                    {i.institution}
                    {i.positions.length > 0 && (
                      <span className="muted"> · {i.positions.join('; ')}</span>
                    )}
                    {i.years.length > 0 && <span className="muted"> · {i.years.join(', ')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            officialRole(r) && (
              <>
                <br />
                <span className="small muted">{officialRole(r)}</span>
              </>
            )
          )}
        </>
      ),
    },
    {
      key: 'companies',
      header: 'Дружества',
      cell: (r) => (
        <ul className="entity-list">
          {(
            r.companies ??
            (r.soleCompany
              ? [
                  {
                    ...r.soleCompany,
                    self: r.stakeKind === 'family' ? 0 : 1,
                    family: r.stakeKind === 'self' ? 0 : 1,
                  },
                ]
              : [])
          ).map((c) => (
            <li key={c.eik}>
              <Link to={`/companies/${c.eik}`}>{c.company}</Link>
              {c.family > 0 && (
                <div>
                  <Chip>{c.self ? 'собствен и свързан дял' : 'дял на свързано лице'}</Chip>
                </div>
              )}
            </li>
          ))}
        </ul>
      ),
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
      // Restrained monochrome chips (no new colour): the two nexus signals, OR-ed across the person's links.
      cell: (r) => (
        <>
          {r.ownInstitution && <Chip>от собствената институция</Chip>}
          {r.ownInstitution && r.hasContemporaneous && ' '}
          {r.hasContemporaneous && <Chip>съвпадение по години</Chip>}
          {r.hasHistoricalLinks && (
            <>
              {' '}
              <Chip>исторически данни</Chip>
            </>
          )}
        </>
      ),
    },
  ];
}

export default function Conflicts({ loaderData }: Route.ComponentProps) {
  const { authority, facets, page, pageCount, total, pageRows, available } = loaderData;
  const [sp] = useSearchParams();
  const filters = conflictListFilters(sp);
  const groups: FilterGroup[] = [
    {
      key: 'stake',
      label: 'Чий е делът',
      type: 'radio',
      allLabel: 'всички',
      selected: filters.stake ? [filters.stake] : [],
      options: [
        {
          value: 'self',
          label: 'собствен',
          count: facets.self,
        },
        {
          value: 'family',
          label: 'на свързано лице',
          count: facets.family,
        },
      ],
    },
    {
      key: 'signal',
      label: 'Признаци',
      type: 'checkbox',
      selected: filters.signals,
      options: [
        {
          value: 'own',
          label: 'от собствената институция',
          count: facets.own,
        },
        {
          value: 'window',
          label: 'съвпадение по години',
          count: facets.window,
        },
      ],
    },
    {
      key: 'institution',
      label: 'Институция на лицето',
      type: 'checkbox',
      selected: filters.institutions,
      options: facets.institutions,
    },
  ];
  const clearHref = authority ? `/conflicts?authority=${authority.slug}` : '/conflicts';
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
          lede="Длъжностни лица, декларирали дял — свой или на свързано лице — в дружество, спечелило обществена поръчка. Показваме и доказани исторически връзки, с декларираните години и проверими източници."
        />

        <Callout titleAs="h2" title="Как се извежда връзката — и какво не твърди">
          <p className="m-0">
            Основата са <strong>собствените декларации</strong> на лицата пред КПКОНПИ (публичен
            регистър). Дружеството се установява чрез ЕИК или съгласувани данни за наименование,
            седалище и вписани роли в Търговския регистър. Неясните и противоречивите съпоставяния
            се задържат за проверка. <strong>Доказаните исторически връзки се запазват</strong> с
            периодите и източниците им. Показваме и дял, деклариран на{' '}
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

        {authority && (
          <p>
            Само изпълнители на <Link to={`/authorities/${authority.slug}`}>{authority.name}</Link>.{' '}
            <Link to="/conflicts">Всички свързани лица →</Link>
          </p>
        )}

        {available === 0 ? (
          <p className="muted">
            {authority
              ? 'Няма публикувани връзки към изпълнители на тази институция.'
              : 'Все още няма публикувани връзки.'}
          </p>
        ) : (
          <>
            <Section
              id="list"
              title="Деклариран дял в компании изпълнители"
              hint="Лица, декларирали дял — свой или на свързано лице — в дружество, спечелило поръчка. По подразбиране са подредени по силата на връзката: първо договори от собствената институция, после съвпадение по години между декларации и договори."
            >
              <div className="split">
                <FilterRail groups={groups} sort={filters.sort} clearHref={clearHref} />
                <section>
                  <ListControls
                    base={sp}
                    activeSort={filters.sort}
                    searchLabel="Търсене сред лицата"
                    sorts={[
                      { value: 'nexus', label: 'сила на връзката' },
                      { value: 'value', label: 'публични средства' },
                      { value: 'contracts', label: 'договори' },
                    ]}
                    count={
                      <>
                        Показани са <strong>{count(pageRows.length)}</strong> от{' '}
                        <strong>{count(total)}</strong> лица
                      </>
                    }
                  />
                  {total === 0 ? (
                    <p className="muted">
                      Няма лица за избраните филтри. <Link to={clearHref}>Изчисти филтрите</Link>
                    </p>
                  ) : (
                    <>
                      <DataTable
                        columns={columns}
                        rows={pageRows}
                        getKey={(r) => r.officialSlug}
                        caption="Длъжностни лица с деклариран дял в компании изпълнители"
                      />
                      {pageCount > 1 && <Pagination nav={nav} pageSize={PER_PAGE} unit="лица" />}
                    </>
                  )}
                </section>
              </div>
            </Section>
          </>
        )}
      </main>
    </>
  );
}
