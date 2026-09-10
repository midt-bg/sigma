import { Link } from 'react-router';
import { EU_SCOREBOARD, type IndicatorRating, rateLowerIsBetter } from '@sigma/config';
import { count, money, moneyBare, pct, periodRange, plural } from '@sigma/shared';
import {
  authorityIdFromSlug,
  getAuthority,
  getAuthorityProcedureCompetition,
  getAuthoritySingleOffer,
  getAuthoritySupplierTies,
  getSpendingTrend,
  getDb,
} from '@sigma/db';
import type { Route } from './+types/authority';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { DataTable } from '../components/DataTable';
import { TrendBlock } from '../components/TrendBlock';
import { TieGraph } from '../components/TieGraph';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { EuBenchmarkStat } from '../components/EuBenchmarkStat';
import { ShareBar, Chip, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { tieColumns, tieRows } from '../lib/entity-tables';
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
  const db = getDb(context.cloudflare.env);
  const authorityId = authorityIdFromSlug(eik);
  return withDbRetry(async () => {
    const [authority, coverage, trend, ties, competition, procedure] = await Promise.all([
      getAuthority(db, authorityId),
      getCoverageMeta(db),
      getSpendingTrend(db, { authorityId, granularity: 'year' }, { includeSectors: false }),
      getAuthoritySupplierTies(db, authorityId),
      getAuthoritySingleOffer(db, authorityId),
      getAuthorityProcedureCompetition(db, authorityId),
    ]);
    if (!authority) throw new Response('Not Found', { status: 404 });
    return { authority, coverage, trend, ties, competition, procedure };
  });
}

// Same wording as the /competition page so the two surfaces never disagree on the verdict.
const RATING_LABEL: Record<IndicatorRating, string> = {
  good: 'в нормата на ЕС',
  mid: 'над целевата стойност на ЕС',
  bad: 'над прага на ЕС',
};

export default function Authority({ loaderData }: Route.ComponentProps) {
  const a = loaderData.authority;
  const { trend, ties, competition, procedure } = loaderData;
  const ct = competition;
  // Both verdicts use the COUNT share - the basis the EU Scoreboard thresholds are defined on.
  const singleOfferRating = rateLowerIsBetter(ct.singleOfferShare, EU_SCOREBOARD.singleBidder);
  const directAwardRating = rateLowerIsBetter(
    procedure.nonCompetitiveShare,
    EU_SCOREBOARD.directAward,
  );
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
            { term: 'Изпълнители', value: count(a.suppliers) },
            topSectors ? { term: 'Основни сектори', value: topSectors } : null,
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
            a.suspect > 0 && {
              term: 'Непотвърдена стойност',
              value: `${count(a.suspect)} ${plural(a.suspect, 'договор', 'договора')}`,
              sub: 'в броя и в сумите, с прогнозната стойност вместо подадената',
            },
          ]}
        />

        <div className="two-col">
          <Section
            id="trend"
            title="Тренд"
            hint={`Разходите на ${a.name} във времето. Договорите без валидна дата не влизат в графиката.`}
          >
            <TrendBlock
              points={trend.points}
              years={trend.years}
              granularity={trend.granularity}
              caption="Разходи по години"
            />
          </Section>

          <Section
            id="single-offer"
            title="Конкуренция"
            hint="Дял на договорите само с една оферта и дял пряко възлагане (без обявление), спрямо праговете на ЕС."
          >
            {ct.contracts > 0 ? (
              <EuBenchmarkStat
                title="Една оферта"
                qualifier="от договорите с известен брой оферти са с една оферта"
                share={ct.singleOfferShare}
                good={EU_SCOREBOARD.singleBidder.good}
                bad={EU_SCOREBOARD.singleBidder.bad}
                rating={singleOfferRating}
                ratingLabel={RATING_LABEL[singleOfferRating]}
                detail={`${count(ct.singleOffer)} от ${count(ct.contracts)} договора · ${money(ct.singleOfferValueEur)} от ${money(ct.valueEur)} по стойност (${pct(ct.singleOfferValueShare)})`}
              />
            ) : (
              <p className="muted">Няма договори с известен брой оферти.</p>
            )}
            {procedure.classifiedContracts > 0 ? (
              <EuBenchmarkStat
                title="Пряко възлагане"
                qualifier="от класифицираните договори са възложени без обявление"
                share={procedure.nonCompetitiveShare}
                good={EU_SCOREBOARD.directAward.good}
                bad={EU_SCOREBOARD.directAward.bad}
                rating={directAwardRating}
                ratingLabel={RATING_LABEL[directAwardRating]}
                detail={`${count(procedure.nonCompetitiveContracts)} от ${count(procedure.classifiedContracts)} класифицирани договора`}
              />
            ) : (
              <div className="ebs">
                <h3 className="ebs-title">Пряко възлагане</h3>
                <p className="muted">Няма класифицирани договори по тип процедура.</p>
              </div>
            )}
            <p className="small muted mt-8">
              Праговете са външен ориентир на Европейската комисия (Single Market Scoreboard), не
              оценка на конкретна процедура.{' '}
              <Link to={`/competition?top=50`}>Виж сравнението с други възложители →</Link>
            </p>
          </Section>
        </div>

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
          id="network"
          title="Най-големи изпълнители и връзките между тях"
          hint={
            <span>
              Изпълнителите с най-много получени средства от институцията, и кои от тях са свързани
              помежду си: съвместно участие в обединение, подизпълнителство, или деклариран интерес
              на едно и също длъжностно лице.{' '}
              <Link to={`/network?center=a:${a.eik}`}>Виж паричната мрежа →</Link>
            </span>
          }
        >
          {ties.center && ties.nodes.length >= 2 ? (
            <>
              <TieGraph data={ties} />
              <div className="sr-only">
                <DataTable
                  columns={tieColumns}
                  rows={tieRows(ties)}
                  getKey={(r) => `${r.from}-${r.to}-${r.kind}`}
                  caption="Изпълнители и връзките между тях"
                />
              </div>
            </>
          ) : (
            <p className="muted">Няма достатъчно данни за схема.</p>
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
