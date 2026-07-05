import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, money, moneyBare, parseConsortiumMembers } from '@sigma/shared';
import { getCompanyFacets, listCompanies } from '@sigma/db';
import type { CompanyListItem } from '@sigma/api-contract';
import type { Route } from './+types/companies';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Chip, OwnershipChip } from '../components/ui';
import {
  buildSectorGroup,
  companyListFilters,
  getMulti,
  leaderboardRankOffset,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';
import { getCoverageMeta, yearOptions } from '../lib/coverage';
import { seoMeta } from '../lib/meta';

const COUNT_BUCKETS = [
  { value: '1', label: '1 договор' },
  { value: '2-5', label: '2–5' },
  { value: '6-20', label: '6–20' },
  { value: '21-100', label: '21–100' },
  { value: '100+', label: '100+' },
];

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/companies',
    title: 'Компании — СИГМА',
    description: 'Всяка компания, спечелила поне един договор по обществена поръчка.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    ...companyListFilters(sp),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.companies,
  };
  const db = context.cloudflare.env.DB;
  const [page, facets, coverage] = await Promise.all([
    listCompanies(db, params),
    getCompanyFacets(db),
    getCoverageMeta(db),
  ]);
  return { page, facets, coverage };
}

function subtitle(c: CompanyListItem) {
  const place = c.settlement ? ` · ${c.settlement}` : '';
  if (c.isConsortium) {
    const parsed = parseConsortiumMembers(c.name);
    const members = parsed?.kind === 'list' ? parsed.members.length : null;
    return members ? `${members} участника${place}` : `обединение${place}`;
  }
  return `${c.hasEik && c.eik ? `ЕИК ${c.eik}` : 'без ЕИК'}${place}`;
}

export default function Companies({ loaderData }: Route.ComponentProps) {
  const { page, facets, coverage } = loaderData;
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'won';
  const nav = pageNav({
    base: sp,
    total: page.total,
    pageSize: PAGE_SIZE.companies,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  });
  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.companies);
  const csvHref = `/companies.csv${withParams(sp, { cursor: null, page: null })}`;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'kind',
      label: 'Вид субект',
      type: 'checkbox',
      selected: getMulti(sp, 'kind'),
      options: facets.kinds.map((k) => ({ value: k.value, label: k.label, count: k.count })),
    },
    {
      key: 'count',
      label: 'Брой договори',
      type: 'radio',
      selected: sp.get('count') ? [sp.get('count')!] : [],
      options: COUNT_BUCKETS,
    },
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: yearOptions(coverage.coverageEndYear).map((y) => ({
        value: y,
        label: y,
      })),
    },
    {
      key: 'eu',
      label: 'Финансиране от ЕС',
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само договори с финансиране от ЕС' },
        { value: 'national', label: 'Само без финансиране от ЕС' },
      ],
    },
  ];

  const columns: Column<CompanyListItem>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => startRank + i + 1 },
    {
      key: 'name',
      header: 'Компания',
      isTitle: true,
      cell: (c) => (
        <>
          <Link to={`/companies/${c.slug}`}>{c.displayName}</Link>
          <br />
          <span className="small muted">{subtitle(c)}</span>
        </>
      ),
    },
    {
      key: 'type',
      header: 'Вид',
      secondary: true,
      cell: (c) => (
        <>
          <Chip>{c.isConsortium ? 'Обединение (ДЗЗД)' : 'дружество'}</Chip>
          {!c.isConsortium && !c.hasEik && (
            <>
              {' '}
              <Chip>без ЕИК</Chip>
            </>
          )}
          {c.ownershipKind && (
            <>
              {' '}
              <OwnershipChip kind={c.ownershipKind} />
            </>
          )}
        </>
      ),
    },
    { key: 'won', header: 'Спечелено (€)', align: 'money', cell: (c) => moneyBare(c.wonEur) },
    { key: 'contracts', header: 'Договори', align: 'money', cell: (c) => count(c.contracts) },
    { key: 'authorities', header: 'Институции', align: 'money', cell: (c) => count(c.authorities) },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Компании' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(page.total)} изпълнители`}
          title="Компании"
          lede="Всяка компания, която е спечелила поне един договор по обществена поръчка. По подразбиране е подреден по общата стойност на спечелените договори."
        />
        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/companies" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              sorts={[
                { value: 'won', label: 'спечелено' },
                { value: 'count', label: 'договори' },
                { value: 'authorities', label: 'институции' },
                { value: 'name', label: 'име' },
              ]}
              count={
                <>
                  Показани са <strong>{page.items.length}</strong> от{' '}
                  <strong>{count(page.total)}</strong> компании
                </>
              }
            />
            {page.items.length === 0 ? (
              <p className="muted">
                Няма резултати за избраните филтри. <Link to="/companies">Изчисти филтрите</Link>
              </p>
            ) : (
              <div aria-busy={busy || undefined}>
                <DataTable
                  columns={columns}
                  rows={page.items}
                  getKey={(c) => c.slug}
                  caption="Компании по спечелено"
                />
              </div>
            )}
            {page.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.companies} />}
            <Callout>
              <h2>Какво означава „спечелено“?</h2>
              <p className="m-0">
                Сборът от стойностите (в евро) на договорите, по които компанията е изпълнител.
                Когато договорът е възложен на обединение (ДЗЗД/консорциум), цялата сума се води на
                обединението като един изпълнител; разбивка по членове ще добавим след свързване с
                Търговския регистър.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
