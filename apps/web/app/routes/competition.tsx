import { Link, useNavigation, useSearchParams } from 'react-router';
import type {
  CompetitionAuthority,
  CompetitionConcentration,
  CompetitionDirectAward,
  CompetitionPair,
} from '@sigma/api-contract';
import { COMPETITION_MIN_CONTRACTS, EU_SCOREBOARD } from '@sigma/config';
import { count, money, pct, plural } from '@sigma/shared';
import { getCompetition, getDb } from '@sigma/db';
import type { Route } from './+types/competition';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { FilterForm, FundingSelect } from '../components/FilterForm';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Chip, Section, ShareBar } from '../components/ui';
import { cached } from '../lib/cache';
import { seoMeta } from '../lib/meta';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { singleSelectFilters } from '../lib/filters';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/competition',
    title: 'Конкуренция — СИГМА',
    description:
      'Къде конкуренцията при обществените поръчки е най-слаба: дял на договорите с една оферта, дял пряко възлагане (без обявление) и концентрация на доставчиците, спрямо референтните стойности на ЕС. Неутрални показатели, всеки проследим до договорите.',
  });
}

// Aggregates over the whole corpus that change only with a data refresh (every 6 h): a cold miss costs
// seconds of D1 work, so the edge keeps the page for the whole refresh interval.
export const headers = cached(21600);

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = getDb(context.cloudflare.env);
  const coverage = await getCoverageMeta(db);
  const years = yearOptions(coverage.coverageEndYear);
  const { sector, year, funding, top, unknownSector, unknownYear } = singleSelectFilters(
    new URL(request.url).searchParams,
    years,
  );
  const data = await getCompetition(db, { sector, year, funding, top });
  return { data, coverage, years, unknownSector, unknownYear };
}

const singleOfferColumns: Column<CompetitionAuthority>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'name',
    header: 'Възложител',
    isTitle: true,
    cell: (r) => <Link to={`/authorities/${r.slug}`}>{r.name}</Link>,
  },
  {
    key: 'type',
    header: 'Вид',
    secondary: true,
    cell: (r) => (r.typeLabel ? <Chip>{r.typeLabel}</Chip> : null),
  },
  {
    key: 'share',
    header: 'Дял с една оферта',
    align: 'num',
    cell: (r) => <ShareBar ratio={r.singleOfferShare} warn={r.singleOfferShare >= 0.5} />,
  },
  {
    key: 'single',
    header: 'С една оферта',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.singleOffer),
  },
  { key: 'contracts', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
];

const concentrationColumns: Column<CompetitionConcentration>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'name',
    header: 'Възложител',
    isTitle: true,
    cell: (r) => <Link to={`/authorities/${r.slug}`}>{r.name}</Link>,
  },
  {
    key: 'type',
    header: 'Вид',
    secondary: true,
    cell: (r) => (r.typeLabel ? <Chip>{r.typeLabel}</Chip> : null),
  },
  {
    key: 'hhi',
    // The two long one-word headers carry a soft hyphen: on a tablet they break at it instead of setting
    // the column wider than the table's box, as the other rankings' several-word headers do on their own.
    header: 'Концен\u00adтрация (HHI)',
    align: 'num',
    cell: (r) => <ShareBar ratio={r.hhi} warn={r.hhi >= 0.25} index />,
  },
  { key: 'suppliers', header: 'Достав\u00adчици', align: 'num', cell: (r) => count(r.suppliers) },
  {
    key: 'contracts',
    header: 'Договори',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.contracts),
  },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
];

const directAwardColumns: Column<CompetitionDirectAward>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
  {
    key: 'name',
    header: 'Възложител',
    isTitle: true,
    cell: (r) => <Link to={`/authorities/${r.slug}`}>{r.name}</Link>,
  },
  {
    key: 'type',
    header: 'Вид',
    secondary: true,
    cell: (r) => (r.typeLabel ? <Chip>{r.typeLabel}</Chip> : null),
  },
  {
    key: 'share',
    header: 'Дял пряко възлагане',
    align: 'num',
    cell: (r) => (
      <ShareBar
        ratio={r.nonCompetitiveShare}
        warn={r.nonCompetitiveShare >= EU_SCOREBOARD.directAward.bad}
      />
    ),
  },
  {
    key: 'direct',
    header: 'Без обявление',
    align: 'num',
    secondary: true,
    cell: (r) => count(r.nonCompetitive),
  },
  { key: 'classified', header: 'Договори', align: 'num', cell: (r) => count(r.classified) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
];

const pairColumns: Column<CompetitionPair>[] = [
  { key: 'rank', header: '#', isRank: true, cell: (r) => r.rank },
  {
    key: 'authority',
    header: 'Възложител',
    isTitle: true,
    cell: (r) => <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>,
  },
  {
    key: 'bidder',
    header: 'Изпълнител',
    cell: (r) => <Link to={`/companies/${r.bidderSlug}`}>{r.bidderDisplayName}</Link>,
  },
  { key: 'contracts', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.wonEur) },
];

export default function Competition({ loaderData }: Route.ComponentProps) {
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const totals: Total[] = [
    { num: pct(data.totals.singleOfferShare), label: 'дял договори с една оферта' },
    { num: pct(data.procedure.nonCompetitiveShare), label: 'дял пряко възлагане (без обявление)' },
    {
      num: count(data.totals.singleOffer),
      label: `${plural(data.totals.singleOffer, 'договор', 'договора')} с една оферта`,
    },
    { num: pct(data.totals.singleOfferValueShare), label: 'дял от стойността с една оферта' },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Конкуренция' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Конкуренция при обществените поръчки"
          lede="Къде конкуренцията е най-слаба: дял на договорите с една-единствена оферта, дял на пряко възложените (без обявление) и колко концентрирани са доставчиците по възложител — съпоставени с референтните стойности на ЕС. Това са неутрални показатели: висок дял е сигнал за слаба конкуренция, не доказателство за нарушение. Зад всяко число стоят конкретните договори."
        />

        <FilterForm
          label="Филтри на анализа"
          values={{
            sector: unknownSector ? '' : sel('sector'),
            year: unknownYear ? '' : sel('year'),
            funding: sel('funding'),
            top: sel('top'),
          }}
        >
          <label>
            Сектор:
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">Всички сектори</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            Година:
            <select name="year" defaultValue={unknownYear ? '' : sel('year')}>
              <option value="">{range}</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <FundingSelect value={sel('funding')} />
          <label>
            Брой:
            <select name="top" defaultValue={sel('top')}>
              <option value="">Топ 20</option>
              <option value="50">Топ 50</option>
            </select>
          </label>
        </FilterForm>

        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {(unknownSector || unknownYear) && (
          <Callout variant="warning" title="Непознат филтър">
            <p style={{ margin: 0 }}>
              {unknownSector && 'Избраният сектор не съществува. '}
              {unknownYear && 'Избраната година е извън обхвата. '}
              Показваме резултатите без него.
            </p>
          </Callout>
        )}

        <TotalsStrip totals={totals} label="Обобщение на конкуренцията" />
        <p className="small muted">
          Делът с една оферта — по брой и по стойност — е от договорите с известен брой оферти (
          {count(data.totals.contracts)} {plural(data.totals.contracts, 'договор', 'договора')} за{' '}
          {money(data.totals.valueEur)}); стойността е сумата на положителните суми. Без филтри това
          е същото число като на началната страница и в „Анализи“.
        </p>

        <Section
          id="single-offer"
          title={
            <>
              Възложители с най-висок дял договори с <em>една оферта</em>
            </>
          }
          hint={`Само възложители с поне ${data.scope.minContracts} договора с известен брой оферти, за да няма шум при малки бройки.`}
        >
          {data.bySingleOffer.length ? (
            <DataTable
              columns={singleOfferColumns}
              rows={data.bySingleOffer}
              getKey={(r) => r.slug}
              caption="Възложители, подредени по дял на договорите с една оферта"
            />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <Section
          id="direct-award"
          title={
            <>
              Възложители с най-висок дял <em>пряко възлагане</em>
            </>
          }
          hint={`Дял на договорите, възложени без обявление (пряко договаряне), от тези с класифицирана процедура. Само възложители с поне ${data.scope.minContracts} такива договора.`}
        >
          {data.byDirectAward.length ? (
            <DataTable
              columns={directAwardColumns}
              rows={data.byDirectAward}
              getKey={(r) => r.slug}
              caption="Възложители, подредени по дял на пряко възложените договори"
            />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <Section
          id="concentration"
          title={
            <>
              Най-висока <em>концентрация</em> на доставчици
            </>
          }
          hint={`Индекс на Херфиндал-Хиршман (HHI) върху разпределението на стойността на договорите на възложителя между изпълнителите: близо до 0 значи разпръснато, 1 — всичко към една фирма; от 0,25 нагоре е висока концентрация. Само възложители с поне ${COMPETITION_MIN_CONTRACTS} договора и поне двама доставчици.`}
        >
          {data.byConcentration.length ? (
            <DataTable
              columns={concentrationColumns}
              rows={data.byConcentration}
              getKey={(r) => r.slug}
              caption="Възложители, подредени по концентрация на доставчиците"
            />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <Section
          id="pairs"
          title={
            <>
              Най-чести двойки <em>възложител и изпълнител</em>
            </>
          }
          hint="Двойки, между които има най-много отделни договори за избрания период."
        >
          {data.topPairs.length ? (
            <DataTable
              columns={pairColumns}
              rows={data.topPairs}
              getKey={(r) => `${r.authoritySlug}-${r.bidderSlug}`}
              caption="Най-чести двойки възложител и изпълнител"
            />
          ) : (
            <p className="muted">Няма достатъчно данни за избраните филтри.</p>
          )}
        </Section>

        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          Показателите са неутрални и описателни, не са оценка на конкретна процедура. Виж{' '}
          <Link to="/methodology#glossary">методологията</Link> за дефинициите.
        </p>
      </main>
    </>
  );
}
