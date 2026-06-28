import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import type { TrendYear } from '@sigma/api-contract';
import { count, money, pct, signedPct } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { getSpendingTrend } from '@sigma/db';
import type { Route } from './+types/trends';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { singleSelectFilters } from '../lib/filters';

export function meta({ location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return [
    { title: t('trends.metaTitle') },
    {
      name: 'description',
      content: t('trends.metaDescription'),
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const { sector, funding, unknownSector } = singleSelectFilters(sp);
  const granularity = sp.get('g') === 'year' ? 'year' : 'month';
  const db = context.cloudflare.env.DB;
  const data = await getSpendingTrend(db, { sector, funding, granularity }, {}, getLocale(request));
  return { data, unknownSector };
}

export default function Trends({ loaderData }: Route.ComponentProps) {
  const { data, unknownSector } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const yearColumns: Column<TrendYear>[] = [
    {
      key: 'year',
      header: t('trends.colYear'),
      isTitle: true,
      cell: (r) => (
        <>
          {r.year}
          {r.partial && <span className="muted">{t('trends.partial')}</span>}
        </>
      ),
    },
    {
      key: 'value',
      header: t('trends.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('trends.colContracts'),
      align: 'num',
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'yoy',
      header: t('trends.colYoy'),
      align: 'num',
      cell: (r) => (r.yoyPct == null ? '' : signedPct(r.yoyPct, 1, locale)),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('trends.breadcrumbHome'), to: '/' },
          { label: t('trends.breadcrumbTrends') },
        ]}
      />
      <main id="main">
        <PageHeader kicker={t('trends.kicker')} title={t('trends.title')} lede={t('trends.lede')} />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label={t('trends.controlsAria')}
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            {t('trends.granularityLabel')}
            <select name="g" defaultValue={sel('g')}>
              <option value="">{t('trends.granularityMonth')}</option>
              <option value="year">{t('trends.granularityYear')}</option>
            </select>
          </label>
          <label>
            {t('trends.sectorLabel')}
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">{t('trends.allSectors')}</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('trends.fundingLabel')}
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">{t('trends.fundingAll')}</option>
              <option value="eu">{t('trends.fundingEu')}</option>
              <option value="national">{t('trends.fundingNational')}</option>
            </select>
          </label>
          <noscript>
            <button type="submit">{t('trends.submit')}</button>
          </noscript>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? t('trends.statusUpdating') : t('trends.statusUpdated')}
        </p>

        {unknownSector && (
          <Callout variant="warning" title={t('trends.unknownTitle')}>
            <p style={{ margin: 0 }}>{t('trends.unknownBody')}</p>
          </Callout>
        )}

        <Section
          id="chart"
          title={
            data.granularity === 'year' ? t('trends.chartTitleYear') : t('trends.chartTitleMonth')
          }
          hint={t('trends.chartHint', { total: money(data.totalValueEur, locale) })}
        >
          {data.points.length >= 2 ? (
            <TrendChart points={data.points} granularity={data.granularity} />
          ) : (
            <p className="muted">{t('trends.notEnough')}</p>
          )}
        </Section>

        <Section id="years" title={t('trends.yearsTitle')} hint={t('trends.yearsHint')}>
          <DataTable
            columns={yearColumns}
            rows={data.years}
            getKey={(r) => r.year}
            caption={t('trends.yearsCaption')}
          />
        </Section>

        <Callout title={t('trends.coverageTitle')}>
          <p style={{ margin: 0 }}>
            {t('trends.coverageBody', { pct: pct(data.coverage.pct, 1, locale) })}
          </p>
        </Callout>
      </main>
    </>
  );
}
