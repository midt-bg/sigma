import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import { count, money, pct } from '@sigma/shared';
import { getRegionalSpending } from '@sigma/db';
import type { Route } from './+types/map';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Choropleth } from '../components/Choropleth';
import { Callout, Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { singleSelectFilters } from '../lib/filters';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Карта на разходите — СИГМА' },
    {
      name: 'description',
      content:
        'Разходите за обществени поръчки по области на България. Къде по картата отиват парите, с класация по области и райони. Областта е известна за част от институциите.',
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
  const { sector, year, funding, unknownSector, unknownYear } = singleSelectFilters(
    new URL(request.url).searchParams,
    years,
  );
  const data = await getRegionalSpending(db, { sector, year, funding });
  return { data, coverage, years, unknownSector, unknownYear };
}

export default function MapRoute({ loaderData }: Route.ComponentProps) {
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';
  const total = data.totalValueEur;

  const totals: Total[] = [
    { num: money(total), label: 'разпределени по области' },
    { num: pct(data.coverage.pct), label: 'дял институции с известна област' },
    { num: money(data.unattributed.valueEur), label: 'без посочена област' },
  ];

  const regionColumns: Column<RegionSpend>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
    { key: 'name', header: 'Област', isTitle: true, cell: (r) => r.name },
    {
      key: 'share',
      header: 'Дял',
      align: 'num',
      cell: (r) => <ShareBar ratio={total > 0 ? r.valueEur / total : 0} />,
    },
    { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
    {
      key: 'contracts',
      header: 'Договори',
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts),
    },
    {
      key: 'authorities',
      header: 'Институции',
      align: 'num',
      secondary: true,
      cell: (r) => count(r.authorities),
    },
  ];

  const macroColumns: Column<MacroRegionSpend>[] = [
    { key: 'name', header: 'Район', isTitle: true, cell: (r) => r.name },
    {
      key: 'share',
      header: 'Дял',
      align: 'num',
      cell: (r) => <ShareBar ratio={total > 0 ? r.valueEur / total : 0} />,
    },
    { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
    {
      key: 'contracts',
      header: 'Договори',
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts),
    },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Карта на разходите' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализ"
          title="Карта на разходите"
          lede="Къде по картата отиват парите за обществени поръчки. Областта се определя по адреса на институцията, така че е известна за част от тях. Институциите без посочена област се показват отделно и не влизат в картата."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Филтри на картата"
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

        <TotalsStrip totals={totals} label="Обобщение по области" />

        <Section id="map" title="Разходи по области">
          <Choropleth regions={data.regions} />
        </Section>

        <Section
          id="regions"
          title="Класация по области"
          hint="Подредени по обща стойност на договорите."
        >
          <DataTable
            columns={regionColumns}
            rows={data.regions}
            getKey={(r) => r.nuts3}
            caption="Области, подредени по обща стойност на договорите"
          />
        </Section>

        <Section id="macro" title="По райони за планиране (NUTS2)">
          <DataTable
            columns={macroColumns}
            rows={data.macroRegions}
            getKey={(r) => r.nuts2}
            caption="Райони за планиране по обща стойност"
          />
        </Section>

        <Callout title="За покритието на данните">
          <p style={{ margin: 0 }}>
            Областта се извежда от адреса на институцията (NUTS) и е известна за{' '}
            {pct(data.coverage.pct)} от институциите. Останалите (
            {money(data.unattributed.valueEur)} по {count(data.unattributed.contracts)} договора) са
            с непосочена област и не са на картата. Виж методологията за подробности.
          </p>
        </Callout>
      </main>
    </>
  );
}
