import { Link } from 'react-router';
import { count, money, moneyBare, pct, periodRange, plural } from '@sigma/shared';
import {
  authorityIdFromSlug,
  getAuthority,
  getAuthoritySingleOffer,
  getEntityNetwork,
  getSpendingTrend,
} from '@sigma/db';
import type { Route } from './+types/authority';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { DataTable } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { NetworkGraph } from '../components/NetworkGraph';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { SingleOfferPortion } from '../components/SingleOfferPortion';
import { ShareBar, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { networkColumns, networkRows, trendYearColumns } from '../lib/entity-tables';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

export function meta({ data, params, matches }: Route.MetaArgs) {
  const name = data?.authority.name ?? 'Институция';
  const range = coverageRange(data?.coverage.coverageEndYear);
  return seoMeta({
    matches,
    path: `/authorities/${params.eik}`,
    title: `${name} — СИГМА`,
    description: `Обществени поръчки на ${name}, ${range}.`,
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const eik = params.eik;
  if (!eik?.trim()) throw new Response('Not Found', { status: 404 });
  const db = context.cloudflare.env.DB;
  const authorityId = authorityIdFromSlug(eik);
  return withDbRetry(async () => {
    const [authority, coverage, trend, network, competition] = await Promise.all([
      getAuthority(db, authorityId),
      getCoverageMeta(db),
      getSpendingTrend(db, { authorityId, granularity: 'month' }, { includeSectors: false }),
      getEntityNetwork(db, { kind: 'authority', id: authorityId }, { includeCenterOptions: false }),
      getAuthoritySingleOffer(db, authorityId),
    ]);
    if (!authority) throw new Response('Not Found', { status: 404 });
    return { authority, coverage, trend, network, competition };
  });
}

export default function Authority({ loaderData }: Route.ComponentProps) {
  const a = loaderData.authority;
  const { trend, network, competition } = loaderData;
  const ct = competition;
  const range = coverageRange(loaderData.coverage.coverageEndYear);
  const topSectors = a.sectors
    .slice(0, 3)
    .map((s) => `${s.short.toLowerCase()} (${pct(s.sharePct)})`)
    .join(', ');
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Институции', to: '/authorities' },
          { label: a.name },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              Институция
              {a.typeLabel && (
                <>
                  {' '}
                  · <Chip>{a.typeLabel}</Chip>
                </>
              )}
            </>
          }
          title={a.name}
          lede={`Колко публични средства е похарчила институцията за обществени поръчки през ${range} г. Зад всяко число по-долу стоят конкретните договори, които го формират.`}
        />

        <FactsList
          label="Ключови показатели"
          rows={[
            { term: 'Обща стойност', value: money(a.spentEur) },
            { term: 'Брой договори', value: count(a.contracts) },
            { term: 'Период', value: periodRange(a.periodFirst, a.periodLast) },
            { term: 'Различни изпълнители', value: count(a.suppliers) },
            {
              term: 'Дял с финансиране от ЕС',
              value: pct(a.euSharePct),
              sub: 'от общия обем',
            },
            a.avgBids != null && {
              term: 'Средно оферти на търг',
              value: a.avgBids.toString().replace('.', ','),
            },
            a.settlement
              ? { term: 'Седалище', value: a.settlement, sub: a.region ?? undefined }
              : { term: 'Седалище', value: <span className="muted">—</span>, sub: 'няма данни' },
            topSectors ? { term: 'Топ сектори', value: topSectors } : null,
            a.suspect > 0 && {
              term: 'Непотвърдена стойност',
              value: `${count(a.suspect)} ${plural(a.suspect, 'договор', 'договора')}`,
              sub: 'изключени от сумите',
            },
          ]}
        />

        <div className="two-col">
          <Section
            id="trend"
            title="Тренд"
            hint={`Разходите на ${a.name} във времето. Договорите без валидна дата не влизат в графиката.`}
          >
            {trend.points.length >= 2 ? (
              <>
                <TrendChart points={trend.points} granularity={trend.granularity} />
                <div className="mt-8">
                  <DataTable
                    columns={trendYearColumns}
                    rows={trend.years}
                    getKey={(r) => r.year}
                    caption="Разходи по години"
                  />
                </div>
              </>
            ) : (
              <p className="muted">Няма достатъчно данни за времева графика.</p>
            )}
          </Section>

          <Section
            id="single-offer"
            title="Една оферта"
            hint="Дял на договорите с известен брой оферти, възложени само с една оферта."
          >
            {ct.contracts > 0 ? (
              <div>
                <SingleOfferPortion
                  valueEur={ct.singleOfferValueEur}
                  totalEur={ct.valueEur}
                  singleOffer={ct.singleOffer}
                  contracts={ct.contracts}
                  scopeLabel="на поръчките"
                  captionSuffix="по стойност"
                />
                <p className="small muted mt-8">
                  <Link to={`/competition?top=50`}>Виж сравнението с други възложители →</Link>
                </p>
              </div>
            ) : (
              <p className="muted">Няма договори с известен брой оферти.</p>
            )}
          </Section>
        </div>

        <Section
          id="network"
          title="Мрежа"
          hint={
            <span>
              Най-силните преки връзки около институцията и по една следваща връзка за всеки
              контрагент. <Link to={`/network?center=a:${a.eik}`}>Виж пълната мрежа →</Link>
            </span>
          }
        >
          {network.center && network.nodes.length >= 2 ? (
            <>
              <NetworkGraph data={network} />
              <div className="sr-only">
                <DataTable
                  columns={networkColumns}
                  rows={networkRows(network)}
                  getKey={(r) => `${r.from}-${r.to}`}
                  caption="Връзки в графа"
                />
              </div>
            </>
          ) : (
            <p className="muted">Няма достатъчно връзки за граф.</p>
          )}
        </Section>

        <Section
          id="top-contractors"
          title="Топ изпълнители"
          hint={`Подредени по общата сума, спечелена от ${a.name}. Колоната „Дял" показва каква част от парите отива при всеки изпълнител.`}
        >
          <div className="table-wrap tbl-cards">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Компания</th>
                  <th scope="col" className="num">
                    Спечелено (€)
                  </th>
                  <th scope="col" className="num">
                    Договори
                  </th>
                  <th scope="col">Дял от общата сума</th>
                </tr>
              </thead>
              <tbody>
                {a.topContractors.map((co, i) => (
                  <tr key={co.slug}>
                    <td className="rank cell-rank" data-label="#">
                      {i + 1}
                    </td>
                    <td className="cell-title" data-label="Компания">
                      <Link to={`/companies/${co.slug}`}>{co.displayName}</Link>
                      {co.kind === 'consortium' && (
                        <>
                          {' '}
                          <Chip>обединение</Chip>
                        </>
                      )}
                    </td>
                    <td className="money" data-label="Спечелено (€)">
                      {moneyBare(co.wonEur)}
                    </td>
                    <td className="money" data-label="Договори">
                      {count(co.contracts)}
                    </td>
                    <td data-label="Дял">
                      <ShareBar ratio={co.sharePct} warn={co.sharePct >= 0.8} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.moreContractors > 0 && (
            <p className="small muted mt-s3">
              <Link to={`/contracts?authority=${a.eik}`}>
                … още {count(a.moreContractors)} изпълнители — виж всички договори →
              </Link>
            </p>
          )}
        </Section>

        <div className="two-col">
          <Section id="what" title="Какво купува" hint="CPV категориите, подредени по обем.">
            <table>
              <caption className="sr-only">Какво купува {a.name} — по CPV категория</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Сектор (CPV)</th>
                  <th scope="col">Стойност и дял</th>
                </tr>
              </thead>
              <tbody>
                {a.sectors.map((s) => (
                  <tr key={s.code}>
                    <td>
                      <Link to={`/contracts?authority=${a.eik}&sector=${s.code}`}>
                        {s.label} (CPV {s.code})
                      </Link>
                    </td>
                    <td className="money">
                      {money(s.valueEur)}
                      <span className="sub">{pct(s.sharePct)}</span>
                    </td>
                  </tr>
                ))}
                {a.sectorsOther && (
                  <tr>
                    <td className="muted">{a.sectorsOther.label}</td>
                    <td className="money">
                      {money(a.sectorsOther.valueEur)}
                      <span className="sub">{pct(a.sectorsOther.sharePct)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>

          <Section id="how" title="Как купува" hint="Разпределение на договорите по вид процедура.">
            <StackedBar slices={a.procedureMix.filter((s) => s.sharePct >= 0.0005)} />
          </Section>
        </div>

        <Section
          id="all"
          title="Договори"
          hint={
            <span>
              {count(a.contracts)} {plural(a.contracts, 'договор', 'договора')}, {range} — превключи
              между най-новите и най-големите по стойност.
            </span>
          }
        >
          <div className="tabset" role="radiogroup" aria-label="Подреждане на договорите">
            <input
              type="radio"
              name="authority-contracts"
              id="authority-recent"
              className="tab-input"
              defaultChecked
            />
            <input
              type="radio"
              name="authority-contracts"
              id="authority-top"
              className="tab-input"
            />
            <div className="tab-labels">
              <label id="tab-authority-recent" htmlFor="authority-recent">
                Най-нови
              </label>
              <label id="tab-authority-top" htmlFor="authority-top">
                Най-големи по стойност
              </label>
            </div>
            <div
              className="tab-panel"
              data-tab="recent"
              role="group"
              aria-labelledby="tab-authority-recent"
            >
              <ContractMiniTable items={a.recentContracts} counterparty="bidder" />
            </div>
            <div
              className="tab-panel"
              data-tab="top"
              role="group"
              aria-labelledby="tab-authority-top"
            >
              <ContractMiniTable items={a.topContracts} counterparty="bidder" />
            </div>
          </div>
          <p className="small muted mt-8">
            <Link to={`/contracts?authority=${a.eik}`}>
              Виж всички / филтрирай / свали като CSV →
            </Link>
          </p>
        </Section>
      </main>
    </>
  );
}
