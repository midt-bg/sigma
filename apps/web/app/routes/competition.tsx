import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type {
  CompetitionAuthority,
  CompetitionConcentration,
  CompetitionDirectAward,
  CompetitionPair,
} from '@sigma/api-contract';
import { EU_SCOREBOARD } from '@sigma/config';
import { count, money, pct } from '@sigma/shared';
import { getCompetition } from '@sigma/db';
import type { Route } from './+types/competition';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Chip, Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { singleSelectFilters } from '../lib/filters';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Конкуренция — СИГМА' },
    {
      name: 'description',
      content:
        'Къде конкуренцията при обществените поръчки е най-слаба: дял на договорите с една оферта, дял пряко възлагане (без обявление) и концентрация на доставчиците, спрямо праговете на ЕС. Неутрални показатели, всеки проследим до договорите.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
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
    header: 'Концентрация (HHI)',
    align: 'num',
    cell: (r) => <ShareBar ratio={r.hhi} warn={r.hhi >= 0.25} />,
  },
  { key: 'suppliers', header: 'Доставчици', align: 'num', cell: (r) => count(r.suppliers) },
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
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const totals: Total[] = [
    { num: pct(data.totals.singleOfferShare), label: 'дял договори с една оферта' },
    { num: pct(data.procedure.nonCompetitiveShare), label: 'дял пряко възлагане (без обявление)' },
    { num: count(data.totals.singleOffer), label: 'договора с една оферта' },
    { num: pct(data.totals.singleOfferValueShare), label: 'дял от стойността с една оферта' },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Конкуренция' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Конкуренция при обществените поръчки"
          lede="Къде конкуренцията е най-слаба: дял на договорите с една-единствена оферта, дял на пряко възложените (без обявление) и колко концентрирани са доставчиците по възложител — съпоставени с праговете на ЕС. Това са неутрални показатели: висок дял е сигнал за слаба конкуренция, не доказателство за нарушение. Зад всяко число стоят конкретните договори."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Филтри на анализа"
          onChange={(e) => submit(e.currentTarget)}
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
          <label>
            Финансиране:
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">Всякакво</option>
              <option value="eu">Само с финансиране от ЕС</option>
              <option value="national">Само без финансиране от ЕС</option>
            </select>
          </label>
          <label>
            Брой:
            <select name="top" defaultValue={sel('top')}>
              <option value="">Топ 20</option>
              <option value="50">Топ 50</option>
            </select>
          </label>
          <noscript>
            <button type="submit">Покажи</button>
          </noscript>
        </Form>

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
          hint="Индекс на Херфиндал-Хиршман (HHI) върху разпределението на разходите на възложителя между изпълнителите: 1 значи всичко към една фирма. Само възложители с поне двама доставчици."
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
