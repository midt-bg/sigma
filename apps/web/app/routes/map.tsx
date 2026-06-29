import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import { count, money, pct, plural } from '@sigma/shared';
import { getRegionalSpending } from '@sigma/db';
import type { Route } from './+types/map';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { useTranslation, useLocale } from '../i18n/context';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Choropleth } from '../components/Choropleth';
import { Callout, Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { singleSelectFilters } from '../lib/filters';

export function meta({ location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return [
    { title: t('map.metaTitle') },
    {
      name: 'description',
      content: t('map.metaDescription'),
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
  const data = await getRegionalSpending(db, { sector, year, funding }, getLocale(request));
  return { data, coverage, years, unknownSector, unknownYear };
}

export default function MapRoute({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  const locale = useLocale();
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';
  const total = data.totalValueEur;

  const totals: Total[] = [
    { num: money(total, locale), label: t('map.totalAllocated') },
    { num: pct(data.coverage.pct, 1, locale), label: t('map.totalKnownRegion') },
    { num: money(data.unattributed.valueEur, locale), label: t('map.totalUnattributed') },
  ];

  const regionColumns: Column<RegionSpend>[] = [
    { key: 'rank', header: t('map.colRank'), isRank: true, cell: (_r, i) => i + 1 },
    { key: 'name', header: t('map.colRegion'), isTitle: true, cell: (r) => r.name },
    {
      key: 'share',
      header: t('map.colShare'),
      align: 'num',
      cell: (r) => <ShareBar ratio={total > 0 ? r.valueEur / total : 0} />,
    },
    {
      key: 'value',
      header: t('map.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('map.colContracts'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'authorities',
      header: t('map.colAuthorities'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.authorities, locale),
    },
  ];

  const macroColumns: Column<MacroRegionSpend>[] = [
    { key: 'name', header: t('map.colMacroRegion'), isTitle: true, cell: (r) => r.name },
    {
      key: 'share',
      header: t('map.colShare'),
      align: 'num',
      cell: (r) => <ShareBar ratio={total > 0 ? r.valueEur / total : 0} />,
    },
    {
      key: 'value',
      header: t('map.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('map.colContracts'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts, locale),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[{ label: t('map.breadcrumbHome'), to: '/' }, { label: t('map.breadcrumbCurrent') }]}
      />
      <main id="main">
        <PageHeader kicker={t('map.kicker')} title={t('map.title')} lede={t('map.lede')} />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label={t('map.filtersAria')}
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            {t('map.sectorLabel')}
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">{t('map.allSectors')}</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('map.yearLabel')}
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
            {t('map.fundingLabel')}
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">{t('map.fundingAny')}</option>
              <option value="eu">{t('map.fundingEu')}</option>
              <option value="national">{t('map.fundingNational')}</option>
            </select>
          </label>
          <noscript>
            <button type="submit">{t('map.apply')}</button>
          </noscript>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? t('map.statusUpdating') : t('map.statusUpdated')}
        </p>

        {(unknownSector || unknownYear) && (
          <Callout variant="warning" title={t('map.unknownFilterTitle')}>
            <p style={{ margin: 0 }}>
              {unknownSector && t('map.unknownSector')}
              {unknownYear && t('map.unknownYear')}
              {t('map.unknownFilterTail')}
            </p>
          </Callout>
        )}

        <TotalsStrip totals={totals} label={t('map.totalsLabel')} />

        <Section id="map" title={t('map.mapSectionTitle')}>
          <Choropleth regions={data.regions} />
        </Section>

        <Section
          id="regions"
          title={t('map.regionsSectionTitle')}
          hint={t('map.regionsSectionHint')}
        >
          <DataTable
            columns={regionColumns}
            rows={data.regions}
            getKey={(r) => r.nuts3}
            caption={t('map.regionsCaption')}
          />
        </Section>

        <Section id="macro" title={t('map.macroSectionTitle')}>
          <DataTable
            columns={macroColumns}
            rows={data.macroRegions}
            getKey={(r) => r.nuts2}
            caption={t('map.macroCaption')}
          />
        </Section>

        <Callout title={t('map.coverageTitle')}>
          <p style={{ margin: 0 }}>
            {t('map.coverageBody', {
              pct: pct(data.coverage.pct, 1, locale),
              value: money(data.unattributed.valueEur, locale),
              contracts: plural(
                data.unattributed.contracts,
                t('map.contracts_one', { count: count(data.unattributed.contracts, locale) }),
                t('map.contracts_many', { count: count(data.unattributed.contracts, locale) }),
                locale,
              ),
            })}
          </p>
        </Callout>
      </main>
    </>
  );
}
