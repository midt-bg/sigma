import { Link, useSearchParams, data, redirect } from 'react-router';
import { count, moneyBare, plural } from '@sigma/shared';
import {
  authorityIdFromSlug,
  getAuthorityName,
  getRelatedPersonRows,
  getRegistryRolePersonRows,
  getDb,
} from '@sigma/db';
import type { Route } from './+types/conflicts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section, Callout, Chip } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { PublicOffices } from '../components/PublicOffices';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { personName } from '../lib/person-name';
import { seoMeta } from '../lib/meta';
import {
  conflictFacets,
  conflictListFilters,
  companyPeriodLabel,
  conflictScopeLine,
  groupDeclaredInstitutions,
  legacyConflictSearch,
  listConflictPeople,
  officialHref,
  officialRole,
  type ConflictPersonRow,
  type ConflictStakeFilter,
} from '../lib/conflicts';
import { withParams, leaderboardRankOffset, type PageNav } from '../lib/filters';

// Длъжностни лица (the route stays /conflicts) — office-holders who declared a material ownership stake, their OWN or a close relative's, in
// a procurement winner. Every row is a PUBLISHED, certainty-1.0 link from the official's own asset declaration
// exact-matched to a winner. Family stakes surface identically to self stakes (ADR-0032, superseding ADR-0030)
// — but the relative is never named and the relationship type is never asserted (relation 'related' only).
export function meta({ matches }: Route.MetaArgs) {
  const tags = seoMeta({
    matches,
    path: '/conflicts',
    title: 'Длъжностни лица — СИГМА',
    description: `${SUBTITLE} ${SCOPE}`,
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

// `?authority=<слug>` narrows the list to the officials whose declared-stake winners that body paid — the
// institution profile links here. A slug that names no institution is a 404, like every other slug on the
// site. It is NOT matched against an ЕИК shape first: the source data leaves a few bodies with an id that
// is not one (several ЕИК in a single field, a URL, a person's name), their profile pages are live, and
// their „Свързани лица“ button carries exactly that id. Dropping a filter we cannot parse would publish the
// WHOLE list of links under one institution's name — the filter either applies or the page refuses.

export async function loader({ request, context }: Route.LoaderArgs) {
  // An old filter link keeps working: it is sent to the same selection under the new parameters.
  const legacy = legacyConflictSearch(new URL(request.url).searchParams);
  if (legacy) throw redirect(`/conflicts${legacy.size ? `?${legacy}` : ''}`, 301);
  const db = getDb(context.cloudflare.env);
  const slug = new URL(request.url).searchParams.get('authority');
  let authority: { slug: string; name: string } | null = null;
  let authorityId: string | undefined;
  if (slug) {
    const id = authorityIdFromSlug(slug);
    const name = await withDbRetry(() => getAuthorityName(db, id));
    if (name == null) throw new Response('Not Found', { status: 404 });
    authority = { slug, name };
    authorityId = id;
  }
  const sp = new URL(request.url).searchParams;
  const filters = conflictListFilters(sp);
  // Declared stakes first; then people the register alone records as owners of a winner, in the same row shape.
  const everyone = (
    await withDbRetry(() =>
      Promise.all([
        getRelatedPersonRows(db, authorityId),
        getRegistryRolePersonRows(db, authorityId),
      ]),
    )
  )
    .flat()
    .map(({ declaredOffices, ...row }) => ({
      ...row,
      declaredInstitutions: groupDeclaredInstitutions(declaredOffices),
      officeFilings: declaredOffices,
    }));
  // By default: ownership or management, with a contract inside the overlap of the office and the tie. The
  // seats on collegial bodies (`?include=boards`) and the ties without such a contract (`?include=outside`)
  // widen it, each on its own.
  const persons = listConflictPeople(everyone, filters);
  const pageCount = Math.max(1, Math.ceil(persons.length / PER_PAGE));
  const asked = Number(sp.get('page') || 1);
  const page = Math.min(pageCount, Number.isSafeInteger(asked) && asked > 0 ? asked : 1);
  const facets = conflictFacets(everyone, filters);
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

const HISTORY =
  'Показваме и доказани исторически връзки, с декларираните години и проверими източници.';
const SUBTITLE =
  'Настоящи и бивши длъжностни лица с декларирани или вписани участия в дружества с обществени поръчки.';
const SCOPE =
  'Списъкът не е регистър на всички длъжностни лица в България и включва исторически данни.';

/** The headings of the list, each true of every row the stake filter keeps: a declared stake, a declared
 *  management, or a role only the Trade Register records. */
function conflictListing(stake: ConflictStakeFilter | null, boards: boolean) {
  switch (stake) {
    case 'registry':
      return {
        title: (
          <>
            Длъжностни лица, вписани в <em>Търговския регистър</em> при изпълнител
          </>
        ),
        lede: `Длъжностни лица, които Търговският регистър вписва като собственик или управител${boards ? ' — или като член на съвет на директорите, управителен съвет или друг орган на управление —' : ''} на дружество, спечелило обществена поръчка. СИГМА не е потвърдила декларирана връзка на лицето с това дружество; когато декларацията го посочва, това е отбелязано при него. ${SCOPE}`,
        caption: 'Длъжностни лица с вписана роля в регистъра при дружества изпълнители',
      };
    case 'self':
      return {
        title: (
          <>
            Длъжностни лица с деклариран <em>дял или управление</em> в компании изпълнители
          </>
        ),
        lede: `Длъжностни лица, декларирали собствен дял в дружество, спечелило обществена поръчка, или че го управляват. ${SCOPE} ${HISTORY}`,
        caption:
          'Длъжностни лица с деклариран дял или декларирано управление в дружества изпълнители',
      };
    case 'family':
      return {
        title: (
          <>
            Длъжностни лица с <em>дял на свързано лице</em> в компании изпълнители
          </>
        ),
        lede: `Длъжностни лица, декларирали дял на свързано лице в дружество, спечелило обществена поръчка. ${SCOPE} ${HISTORY}`,
        caption: 'Длъжностни лица с деклариран дял на свързано лице в дружества изпълнители',
      };
    default:
      return {
        title: (
          <>
            Длъжностни лица и <em>дружества</em> изпълнители
          </>
        ),
        lede: `${SUBTITLE} ${SCOPE} ${HISTORY}`,
        caption:
          'Длъжностни лица и дружества изпълнители: деклариран дял, декларирано управление или вписана роля в регистъра',
      };
  }
}

// The columns of the /conflicts person leaderboard (#287, plan §3.2). Rank is the corner badge on phone
// (isRank); the person name+institution becomes the card heading (isTitle).
function personColumns(startRank: number): Column<ConflictPersonRow>[] {
  return [
    { key: 'rank', header: '№', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'official',
      header: 'Длъжностно лице',
      isTitle: true,
      cell: (r) => (
        <>
          <Link to={officialHref(r.officialSlug)}>{personName(r.official)}</Link>
          {(r.declaredInstitutions?.length ?? 0) > 0 ? (
            <PublicOffices filings={r.officeFilings} />
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
              {!c.self && !c.family && !!c.manages && (
                <div>
                  <Chip>{c.board ? 'декларирано членство в съвет' : 'декларирано управление'}</Chip>
                </div>
              )}
              {c.registry && (
                <div>
                  <Chip>
                    {c.registryRole === 'board'
                      ? 'членство в съвет по Търговския регистър'
                      : c.registryRole === 'manager'
                        ? 'управление по Търговския регистър'
                        : 'дял по Търговския регистър'}
                  </Chip>
                  {c.declared ? (
                    <div className="small muted">
                      {c.declared === 'stake'
                        ? 'В декларацията: собствен дял.'
                        : c.declared === 'manages'
                          ? 'В декларацията: управление.'
                          : c.declared === 'family'
                            ? 'В декларацията: дял на свързано лице.'
                            : 'Посочено в декларацията.'}
                    </div>
                  ) : null}
                  {c.missingYears?.length ? (
                    <div className="small muted">
                      СИГМА не го откри в годишната декларация за {c.missingYears.join(', ')}
                      &nbsp;г.
                    </div>
                  ) : null}
                </div>
              )}
              {companyPeriodLabel(c) && (
                <div>
                  <Chip>{companyPeriodLabel(c)}</Chip>
                </div>
              )}
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'periodValue',
      header: 'Стойност в периода на длъжността',
      align: 'money',
      cell: (r) => moneyBare(r.contemporaneousValueEur),
    },
    {
      key: 'totalValue',
      header: 'Стойност за всички години',
      align: 'money',
      cell: (r) => moneyBare(r.contractValueEur),
    },
    {
      key: 'contracts',
      header: 'Договори за всички години',
      align: 'money',
      cell: (r) => count(r.contractCount),
    },
    {
      key: 'signals',
      header: 'Признаци',
      // The column states the facts the reader has no other column for, and says „—“ when there are
      // none. Carrying the own-institution chip alone left it blank on 98% of the rows, which reads as
      // a broken column rather than as „nothing to note here“. A contract in the period is said here, as a
      // fact about the person's row, and only ever in the positive: its absence is not a label.
      cell: (r) => {
        const disputed = r.companies?.some((c) => c.missingYears?.length);
        const chips = [
          r.ownInstitution && (
            <Chip key="own" tone="strong">
              от собствената институция
            </Chip>
          ),
          r.hasContemporaneous && (
            <Chip key="window" tone="window">
              с договори в периода на длъжността
            </Chip>
          ),
          r.stakeKind === 'registry' && !r.companies?.some((c) => c.declared) && (
            <Chip key="registry">само по Търговския регистър</Chip>
          ),
          disputed && <Chip key="disputed">не е открито в декларация</Chip>,
        ].filter(Boolean);
        return chips.length ? (
          <span className="signal-chips">{chips}</span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
  ];
}

export default function Conflicts({ loaderData }: Route.ComponentProps) {
  const { authority, facets, page, pageCount, total, pageRows, available } = loaderData;
  const [sp] = useSearchParams();
  const filters = conflictListFilters(sp);
  // A payload cached before these facets existed lacks them: the groups then show without counts.
  const f = facets as Partial<typeof facets>;
  const groups: FilterGroup[] = [
    {
      // Both off by default; each widens the list on its own, so all four combinations are a choice.
      key: 'include',
      label: 'Разшири списъка',
      type: 'checkbox',
      selected: [
        ...(filters.period === 'any' ? ['outside'] : []),
        ...(filters.role === 'all' ? ['boards'] : []),
      ],
      options: [
        {
          value: 'outside',
          label: 'с договори извън периода',
          count: f.include?.outside,
        },
        {
          value: 'boards',
          label: 'с членове на управителни органи',
          count: f.include?.boards,
        },
      ],
    },
    {
      key: 'source',
      label: 'Източник на връзката',
      type: 'radio',
      allLabel: 'всички',
      allCount: f.source?.all,
      selected: filters.stake ? [filters.stake] : [],
      options: [
        {
          value: 'self',
          label: 'собствено участие',
          count: f.source?.self,
        },
        {
          value: 'family',
          label: 'дял на свързано лице',
          count: f.source?.family,
        },
        {
          value: 'registry',
          label: 'само Търговски регистър',
          count: f.source?.registry,
        },
      ],
    },
    {
      key: 'buyer',
      label: 'Възложител на договорите',
      type: 'radio',
      allLabel: 'всички',
      allCount: f.buyer?.all,
      selected: filters.ownBuyer ? ['own'] : [],
      options: [
        {
          value: 'own',
          label: 'собствената институция',
          count: f.buyer?.own,
        },
      ],
    },
    {
      key: 'institution',
      label: 'Институция на лицето',
      type: 'checkbox',
      selected: filters.institutions,
      options: f.institutions ?? [],
    },
  ];
  // Every heading over the list must be true of every row it shows. Unfiltered, the list holds declared
  // stakes, declared management and roles the register alone records, so its headings name all three; a
  // filter narrows them to what it keeps.
  const listing = conflictListing(filters.stake, filters.role === 'all');
  const clearHref = authority ? `/conflicts?authority=${authority.slug}` : '/conflicts';
  const columns = personColumns(leaderboardRankOffset(page, PER_PAGE));
  // An empty list offers the wider scopes that would fill it, every other filter kept. On an empty list
  // the people a box adds are the people it would show.
  const include = groups[0]!.selected;
  const steps = [
    filters.period === 'overlap' && {
      add: ['outside'],
      label: 'Добави лицата с договори извън периода на длъжността',
      count: f.include?.outside ?? 0,
    },
    filters.role === 'direct' && {
      add: ['boards'],
      label: 'Добави членовете на управителни органи',
      count: f.include?.boards ?? 0,
    },
  ].filter((w): w is { add: string[]; label: string; count: number } => !!w);
  // Both boxes at once only when that finds more than either alone.
  const both = steps.length === 2 ? (f.include?.both ?? 0) : 0;
  if (both > Math.max(...steps.map((w) => w.count)))
    steps.push({
      add: ['outside', 'boards'],
      label: 'Добави и двете групи',
      count: both,
    });
  const widen = steps
    .filter((w) => w.count > 0)
    .map((w) => ({
      ...w,
      href: withParams(sp, { include: [...new Set([...include, ...w.add])], page: null }),
    }));
  const nav: PageNav = {
    page,
    pageCount,
    prevHref: page > 1 ? withParams(sp, { page: page - 1 }) : null,
    nextHref: page < pageCount ? withParams(sp, { page: page + 1 }) : null,
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Длъжностни лица' }]} />
      <main id="main">
        <PageHeader kicker="Длъжностни лица" title={listing.title} lede={listing.lede} />

        <Callout titleAs="h2" title="Как се извежда връзката — и какво не твърди">
          <p className="m-0">
            Основата са <strong>собствените декларации</strong> на лицата в{' '}
            <strong>
              публичния регистър на декларациите на лицата, заемащи публични длъжности
            </strong>{' '}
            — от 2&nbsp;ноември 2026&nbsp;г. го води Комисията за противодействие на корупцията, а
            дотогава го водеше Сметната палата. Дружеството е неговият ЕИК — деклариран или този, до
            който води декларираното наименование — и се потвърждава от вписаните в Търговския
            регистър лица. Неясните и противоречивите съпоставяния се задържат за проверка.{' '}
            <strong>Доказаните исторически връзки се запазват</strong> с периодите и източниците им.
            Показваме и дял, деклариран на <strong>свързано лице</strong> — наравно със собствения —
            защото декларацията съществува именно за да е видимо дали публични пари стигат до
            дружество, свързано с човек с власт над тези пари.{' '}
            <strong>Името на близкия показваме само когато Търговският регистър го вписва</strong>,
            а видът на връзката <strong>не се твърди</strong> — казваме само „свързано лице“, не
            „съпруг“ или „дете“. Връзката означава деклариран интерес, а <strong>не</strong>{' '}
            нарушение или конфликт по закон. Повече:{' '}
            <Link to="/conflicts/methodology#shown">Методология → Какво показваме</Link>. Сигнал за
            неточност: <Link to="/conflicts/methodology#contest">Поправки</Link>.
          </p>
        </Callout>

        {authority && (
          <p>
            Само изпълнители на <Link to={`/authorities/${authority.slug}`}>{authority.name}</Link>.{' '}
            <Link to="/conflicts">Всички длъжностни лица →</Link>
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
              title="Длъжностни лица и дружества изпълнители"
              hint={
                <>
                  Сумите са стойности на договорите на дружествата, не пари, получени от лицата.
                  Периодът на длъжността са годините с декларация за нея, в които връзката с
                  дружеството е декларирана или вписана — не точните дати на мандата.{' '}
                  <Link to="/conflicts/methodology#office-period">Как се смята</Link>
                </>
              }
            >
              <div className="split">
                <FilterRail groups={groups} sort={filters.sort} clearHref={clearHref} />
                <section id="results" tabIndex={-1}>
                  <ListControls
                    base={sp}
                    activeSort={filters.sort}
                    searchLabel="Търсене сред лицата"
                    sorts={[
                      { value: 'period', label: 'стойност в периода' },
                      { value: 'total', label: 'стойност за всички години' },
                      { value: 'contracts', label: 'брой договори' },
                    ]}
                    count={
                      <>
                        Показани са <strong>{count(pageRows.length)}</strong> от{' '}
                        <strong>{count(total)}</strong> {plural(total, 'лице', 'лица')}
                      </>
                    }
                  />
                  <p className="small muted conflicts-scope">
                    Обхват: {conflictScopeLine(filters)}
                  </p>
                  {total === 0 ? (
                    <div className="conflicts-empty">
                      <p className="muted">Няма лица за избраните филтри.</p>
                      {widen.length > 0 && (
                        <ul className="conflicts-widen">
                          {widen.map((w) => (
                            <li key={w.href}>
                              <Link to={w.href}>{w.label}</Link>{' '}
                              <span className="muted small">
                                {count(w.count)} {plural(w.count, 'лице', 'лица')}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="small">
                        <Link to={clearHref}>Изчисти филтрите</Link>
                      </p>
                    </div>
                  ) : (
                    <>
                      <DataTable
                        className="conflicts-people-table"
                        columns={columns}
                        rows={pageRows}
                        getKey={(r) => r.officialSlug}
                        caption={listing.caption}
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
