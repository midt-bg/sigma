import { Link, useNavigation, useSearchParams } from 'react-router';
import { count, date, money, moneyBare } from '@sigma/shared';
import { contractsSummary, getContractFacets, listContracts, getDb } from '@sigma/db';
import type { Route } from './+types/contracts';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FilterRail, type FilterGroup } from '../components/FilterRail';
import { ListControls } from '../components/ListControls';
import { Pagination } from '../components/Pagination';
import { Callout } from '../components/ui';
import {
  buildSectorGroup,
  contractListFilters,
  getMulti,
  leaderboardRankOffset,
  pageNav,
  withParams,
  PAGE_SIZE,
} from '../lib/filters';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { PRIVACY_MASK_APPLIED, PRIVACY_MASK_MARKER } from '../lib/security';

const VALUE_BUCKETS = [
  { value: 'lt100k', label: 'Под 100 хил. €' },
  { value: '100k-1m', label: '100 хил. – 1 млн. €' },
  { value: '1m-10m', label: '1 – 10 млн. €' },
  { value: '10m-100m', label: '10 – 100 млн. €' },
  { value: 'gt100m', label: 'Над 100 млн. €' },
];

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/contracts',
    title: 'Договори — СИГМА',
    description:
      'Всеки сключен договор по обществена поръчка. Филтрите са в адреса, има и сваляне в CSV.',
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  // Forward the internal privacy-mask marker set by the loader on the `.data` Response. React
  // Router's `getDocumentHeadersImpl` does not auto-propagate loader headers (only `Set-Cookie`),
  // so the route must forward explicitly — without this the worker `hardenResponse` cannot
  // translate the marker into `X-Robots-Tag: noindex` on the HTML response. (PR #183 review #1:
  // the contract leaderboard exposes masked sole-trader rows via the shared `toItem` mapper; the
  // marker ensures the .data twin — RRv7 single-fetch — also carries noindex when ANY row on the
  // page is masked.) The header name + value come from the shared `PRIVACY_MASK_MARKER` /
  // `PRIVACY_MASK_APPLIED` constants in `security.ts` (ydimitrof review 2026-09-03, thread on
  // apps/web/app/routes/companies.tsx:88, applied here for parity) so a future rename of the
  // marker cannot silently desync this route from the worker translation.
  const headers: Record<string, string> = {
    'Cache-Control': loaderHeaders.get('Cache-Control') ?? publicCache(1800),
  };
  if (loaderHeaders.get(PRIVACY_MASK_MARKER) === PRIVACY_MASK_APPLIED) {
    headers[PRIVACY_MASK_MARKER] = PRIVACY_MASK_APPLIED;
  }
  return headers;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  // Filters come from the shared parser so the HTML list and the CSV export apply an identical set
  // (issue #138); only pagination is route-specific here.
  const params = {
    ...contractListFilters(sp),
    cursor: sp.get('cursor'),
    pageSize: PAGE_SIZE.contracts,
  };
  const { env } = context.cloudflare;
  const db = getDb(env);
  // Page `Cache-Control` (publicCache(1800)) memoises full responses at the edge — no per-query cache.
  return withDbRetry(async () => {
    const [summary, facets] = await Promise.all([
      contractsSummary(db, params),
      getContractFacets(db),
    ]);
    const result = await listContracts(db, params, summary);
    // Privacy (PR #183 review #1): if any row on this page was masked by the shared `toItem`
    // mapper (sole trader / natural person), stamp the privacy-mask marker so the worker
    // `hardenResponse` translates it into `X-Robots-Tag: noindex` on the `.data` twin (RRv7
    // single-fetch). The marker is internal — it never reaches the client. Mirrors the
    // company-detail loader's per-row marker pattern. The detection reads the `masked`
    // boolean the mapper sets on the same branch (lyubomir-bozhinov review 2026-09-02,
    // thread on packages/db/src/queries/rows.ts:86) instead of string-comparing
    // `MASKED_NATURAL_PERSON_LABEL` — the flag is the single source-of-truth for the masking
    // signal, kept in lock-step with the label and the opaque slug inside `toItem`.
    if (result.items.some((c) => c.masked)) {
      return Response.json(
        { result, facets },
        {
          // Header name + value from the shared constants in `security.ts` (ydimitrof review
          // 2026-09-03, PR #344, thread on apps/web/app/routes/companies.tsx:88, applied here
          // for parity). Cache-Control added for the same reason: this Response is served on the
          // `.data` URL directly by RRv7, bypassing the route's `headers()` above, so the edge
          // cache would otherwise treat it as not cacheable.
          headers: {
            [PRIVACY_MASK_MARKER]: PRIVACY_MASK_APPLIED,
            'Cache-Control': publicCache(1800),
          },
        },
      );
    }
    return { result, facets };
  });
}

export default function Contracts({ loaderData }: Route.ComponentProps) {
  const { result, facets } = loaderData;
  const [sp] = useSearchParams();
  const sort = sp.get('sort') ?? 'value-desc';
  const nav = pageNav({
    base: sp,
    total: result.total,
    pageSize: PAGE_SIZE.contracts,
    nextCursor: result.nextCursor,
    prevCursor: result.prevCursor,
  });
  const csvHref = `/contracts.csv${withParams(sp, { cursor: null, page: null })}`;
  const fAuthority = sp.get('authority');
  const fBidder = sp.get('bidder');
  const filtered = fAuthority || fBidder;
  // A filtered view shares one authority/bidder across every row, so the name is taken from the
  // first result (null when the filter combined with others yields no rows — then show the label only).
  const filterAuthorityName = fAuthority ? (result.items[0]?.authorityName ?? null) : null;
  const filterBidderName = fBidder ? (result.items[0]?.bidderDisplayName ?? null) : null;
  const busy = useNavigation().state !== 'idle';

  const groups: FilterGroup[] = [
    buildSectorGroup(
      facets.sectors.map((s) => ({ value: s.value, label: s.label, count: s.count })),
      getMulti(sp, 'sector'),
    ),
    {
      key: 'procedure',
      label: 'Процедура',
      type: 'checkbox',
      selected: getMulti(sp, 'procedure'),
      options: facets.procedures.map((p) => ({ value: p.value, label: p.label, count: p.count })),
    },
    {
      key: 'year',
      label: 'Година',
      type: 'checkbox',
      selected: getMulti(sp, 'year'),
      options: facets.years.map((y) => ({ value: y.value, label: y.label, count: y.count })),
    },
    {
      key: 'value',
      label: 'Стойност (в евро)',
      type: 'radio',
      selected: sp.get('value') ? [sp.get('value')!] : [],
      options: VALUE_BUCKETS,
    },
    {
      key: 'eu',
      label: 'Финансиране от ЕС',
      type: 'radio',
      selected: sp.get('eu') ? [sp.get('eu')!] : [],
      options: [
        { value: 'eu', label: 'Само с финансиране от ЕС' },
        { value: 'national', label: 'Само без финансиране от ЕС' },
      ],
    },
  ];

  const startRank = leaderboardRankOffset(nav.page, PAGE_SIZE.contracts);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Договори' }]} />
      <main id="main">
        <PageHeader
          kicker={`${count(result.total)} договора`}
          title="Договори"
          lede="Всеки сключен договор по обществена поръчка. Всяко обобщение другаде в платформата — обща сума за институция, за компания или поток между двете — се свежда точно до този списък. Филтрите остават в адреса."
        />

        <div className="split">
          <FilterRail groups={groups} sort={sort} clearHref="/contracts" csvHref={csvHref} />
          <section>
            <ListControls
              base={sp}
              activeSort={sort}
              searchLabel="Търсене сред договорите"
              sorts={[
                { value: 'date-desc', label: 'нови' },
                { value: 'date-asc', label: 'стари' },
                { value: 'value-desc', label: 'стойност ↓' },
                { value: 'value-asc', label: 'стойност ↑' },
              ]}
              count={
                <>
                  Намерени <strong>{count(result.total)}</strong> договора ·{' '}
                  <strong>{money(result.valueEur)}</strong>
                  {result.suspect > 0 && (
                    <>
                      {' '}
                      · <span className="suspect">{result.suspect} с непотвърдена стойност</span>
                    </>
                  )}
                </>
              }
            />

            {filtered && (
              <p className="active-filters">
                Филтрирано по{' '}
                {fAuthority && (
                  <>
                    институция
                    {filterAuthorityName ? (
                      <>
                        {' '}
                        <strong>{filterAuthorityName}</strong>
                      </>
                    ) : null}
                  </>
                )}
                {fAuthority && fBidder ? ' и ' : ''}
                {fBidder && (
                  <>
                    компания
                    {filterBidderName ? (
                      <>
                        {' '}
                        <strong>{filterBidderName}</strong>
                      </>
                    ) : null}
                  </>
                )}{' '}
                ·{' '}
                <Link
                  to={withParams(sp, { authority: null, bidder: null, cursor: null, page: null })}
                >
                  изчисти
                </Link>
              </p>
            )}

            {result.items.length === 0 ? (
              <p className="muted">
                Няма резултати за избраните филтри. <Link to="/contracts">Изчисти филтрите</Link>
              </p>
            ) : (
              <div className="table-wrap tbl-cards" aria-busy={busy || undefined}>
                <table>
                  <caption className="sr-only">Договори по обществени поръчки</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="col-w-32">
                        #
                      </th>
                      <th scope="col">Договор</th>
                      <th scope="col">Възложител · Изпълнител</th>
                      <th scope="col" className="col-secondary">
                        Процедура · Дата
                      </th>
                      <th scope="col" className="num">
                        Стойност (€)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((c, i) => (
                      <tr className="contract-row" key={c.id}>
                        <td className="rank cell-rank" data-label="#">
                          {startRank + i + 1}
                        </td>
                        <td className="subj cell-title" data-label="Договор">
                          <Link className="title" to={`/contracts/${c.id}`}>
                            {c.subject}
                          </Link>
                          {c.euFunded && <span className="eu">ЕС</span>}
                          <span className="unp">
                            УНП {c.unp}
                            {c.isConsortium ? ' · обединение' : ''}
                          </span>
                        </td>
                        <td className="parties" data-label="Възложител · Изпълнител">
                          <span className="from">
                            <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>{' '}
                            <span className="who">възложител</span>
                          </span>
                          <span className="to">
                            {/* Masked (sole-trader / natural-person) rows on the contract list —
                                which is noindexed when ANY row on the page is masked (the loader
                                stamps `X-Privacy-Mask` for the worker `hardenResponse` to translate
                                to `X-Robots-Tag: noindex` on the `.data` twin) — must STILL render
                                as a non-link `<span>`: the masked profile's opaque slug is
                                non-resolvable by design, and rendering it as a `<Link>` would either
                                leak the pre-fix bare ЕИК or 404 against the new opaque form. Same
                                invariant as companies.tsx:174-178 + home.tsx:63-199 — the masked profile
                                is reachable only via direct URL or a noindexed contract-page backlink
                                (none of those exist for /contracts, since every contract page that
                                lists a masked bidder is itself noindexed via the masked-bidder
                                detection in the contract page's loader, mirroring
                                company.tsx:50-58). lyubomir-bozhinov review 2026-09-02, thread on
                                packages/db/src/queries/rows.ts:86 (extended to the contract mapper). */}
                            {c.masked ? (
                              <span>{c.bidderDisplayName}</span>
                            ) : (
                              <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                            )}{' '}
                            <span className="who">изпълнител</span>
                          </span>
                        </td>
                        <td className="meta col-secondary" data-label="Процедура · Дата">
                          <span className="pr">{c.procedureLabel}</span>
                          <br />
                          {date(c.signedAt)}
                        </td>
                        <td className="money" data-label="Стойност (€)">
                          {c.valueEur != null ? (
                            moneyBare(c.valueEur)
                          ) : (
                            <span className="suspect">данните се проверяват</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.items.length > 0 && <Pagination nav={nav} pageSize={PAGE_SIZE.contracts} />}

            <Callout>
              <h2>Какво е „договор“ в СИГМА</h2>
              <p className="m-0">
                Един възложен договор по обществена поръчка, на ниво обособена позиция (лот).
                Стойностите са в евро — изчистена, съпоставима стойност на договора.
              </p>
            </Callout>
          </section>
        </div>
      </main>
    </>
  );
}
