import { Link } from 'react-router';
import { count, money, pct, periodRange, plural } from '@sigma/shared';
import { authorityIdFromSlug, getAuthority } from '@sigma/db';
import type { Route } from './+types/authority';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { ShareBar, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { withDbRetry } from '../lib/retry';

export function meta({ data }: Route.MetaArgs) {
  const name = data?.authority.name ?? 'Институция';
  const range = coverageRange(data?.coverage.coverageEndYear);
  return [
    { title: `${name} — СИГМА` },
    { name: 'description', content: `Обществени поръчки на ${name}, ${range}.` },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const eik = params.eik;
  if (!eik?.trim()) throw new Response('Not Found', { status: 404 });
  const db = context.cloudflare.env.DB;
  return withDbRetry(async () => {
    const [authority, coverage] = await Promise.all([
      getAuthority(db, authorityIdFromSlug(eik)),
      getCoverageMeta(db),
    ]);
    if (!authority) throw new Response('Not Found', { status: 404 });
    return { authority, coverage };
  });
}

export default function Authority({ loaderData }: Route.ComponentProps) {
  const a = loaderData.authority;
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
                    Спечелено
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
                    <td className="money" data-label="Спечелено">
                      {money(co.wonEur)}
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
            <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
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
              {count(a.contracts)} {plural(a.contracts, 'договор', 'договора')}, {range} —
              превключи между най-новите и най-големите по стойност.
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
          <p className="small muted" style={{ marginTop: 8 }}>
            <Link to={`/contracts?authority=${a.eik}`}>
              Виж всички / филтрирай / свали като CSV →
            </Link>
          </p>
        </Section>
      </main>
    </>
  );
}
