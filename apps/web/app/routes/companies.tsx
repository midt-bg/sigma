import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, money, parseConsortiumMembers } from '@sigma/shared';
import { getCompanyFacets, listCompanies } from '@sigma/db';
import type { CompanyListItem } from '@sigma/api-contract';
import type { Route } from './+types/companies';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { DataTable, type Column } from '../components/DataTable';
import { Callout, Chip } from '../components/ui';
import {
  buildSectorGroup,
  companyListParams,
  getMulti,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';

const COUNT_BUCKETS = [
  { value: '1', label: '1 договор' },
  { value: '2-5', label: '2–5' },
  { value: '6-20', label: '6–20' },
  { value: '21-100', label: '21–100' },
  { value: '100+', label: '100+' },
];

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Компании — СИГМА' },
    {
      name: 'description',
      content: 'Всяка компания, спечелила поне един договор по обществена поръчка.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const params = {
    ...companyListParams(sp),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.companies,
  };
  const db = context.cloudflare.env.DB;
  const [page, facets] = await Promise.all([listCompanies(db, params), getCompanyFacets(db)]);
  return { page, facets };
}

function subtitle(c: CompanyListItem) {
  const place = c.settlement ? ` · ${c.settlement}` : '';
  if (c.kind === 'consortium') {
    const parsed = parseConsortiumMembers(c.name);
    const members = parsed?.kind === 'list' ? parsed.members.length : null;
    return members ? `${members} участника${place}` : `обединение${place}`;
  }
  return `${c.eik ? `ЕИК ${c.eik}` : 'непотвърден ЕИК'}${place}`;
}

export default function Companies({ loaderData }: Route.ComponentProps) {
  const { page, facets } = loaderData;
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'won';
  const nav = pageNav({
    base: sp,
    total: page.total,
    pageSize: PAGE_SIZE.companies,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
  });
  const startRank = 0;
  const csvHref = `/companies.csv${withParams(sp, { cursor: null, page: null, q: null })}`;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'kind',
      label: 'Тип субект',
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
      options: ['2026', '2025', '2024', '2023', '2022', '2021', '2020'].map((y) => ({
        value: y,
        label: y,
      })),
    },
    {
      key: 'eu',
      label: 'ЕС финансиране',
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само договори с ЕС финансиране' },
        { value: 'national', label: 'Само без ЕС' },
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
      header: 'Тип',
      secondary: true,
      cell: (c) => <Chip>{c.kind === 'consortium' ? 'обединение' : 'дружество'}</Chip>,
    },
    { key: 'won', header: 'Спечелено', align: 'money', cell: (c) => money(c.wonEur) },
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
          lede="Всяка компания, която е спечелила поне един договор по обществена поръчка. По подразбиране списъкът е подреден по обща стойност на спечелените договори."
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
              <h2
                style={{
                  font: '400 18px/1.25 var(--font-serif)',
                  letterSpacing: '-0.01em',
                  color: 'var(--ink, #111)',
                  marginBottom: 6,
                }}
              >
                Какво означава „спечелено“?
              </h2>
              <p style={{ margin: 0 }}>
                Сумата от стойностите на договорите (в евро), по които компанията е изпълнител.
                Когато договорът е възложен на обединение (ДЗЗД/консорциум), цялата сума се отчита
                на обединението като един изпълнител; разбивка по членове ще се добави след
                свързване с Търговския регистър.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
