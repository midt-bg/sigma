import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { Link } from '../i18n/Link';
import type {
  CompetitionAuthority,
  CompetitionConcentration,
  CompetitionPair,
} from '@sigma/api-contract';
import { count, money, pct } from '@sigma/shared';
import { getCompetition } from '@sigma/db';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import type { Route } from './+types/competition';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { TotalsStrip, type Total } from '../components/TotalsStrip';
import { Callout, Chip, Section, ShareBar } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { singleSelectFilters } from '../lib/filters';

export function meta({ location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return [
    { title: t('competition.metaTitle') },
    {
      name: 'description',
      content: t('competition.metaDescription'),
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
  const data = await getCompetition(db, { sector, year, funding, top }, getLocale(request));
  return { data, coverage, years, unknownSector, unknownYear };
}

export default function Competition({ loaderData }: Route.ComponentProps) {
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  const singleOfferColumns: Column<CompetitionAuthority>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
    {
      key: 'name',
      header: t('competition.colAuthority'),
      isTitle: true,
      cell: (r) => <Link to={`/authorities/${r.slug}`}>{r.name}</Link>,
    },
    {
      key: 'type',
      header: t('competition.colType'),
      secondary: true,
      cell: (r) => (r.typeLabel ? <Chip>{r.typeLabel}</Chip> : null),
    },
    {
      key: 'share',
      header: t('competition.colSingleOfferShare'),
      align: 'num',
      cell: (r) => <ShareBar ratio={r.singleOfferShare} warn={r.singleOfferShare >= 0.5} />,
    },
    {
      key: 'single',
      header: t('competition.colSingleOffer'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.singleOffer, locale),
    },
    {
      key: 'contracts',
      header: t('competition.colContracts'),
      align: 'num',
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'value',
      header: t('competition.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
  ];

  const concentrationColumns: Column<CompetitionConcentration>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (_r, i) => i + 1 },
    {
      key: 'name',
      header: t('competition.colAuthority'),
      isTitle: true,
      cell: (r) => <Link to={`/authorities/${r.slug}`}>{r.name}</Link>,
    },
    {
      key: 'type',
      header: t('competition.colType'),
      secondary: true,
      cell: (r) => (r.typeLabel ? <Chip>{r.typeLabel}</Chip> : null),
    },
    {
      key: 'hhi',
      header: t('competition.colHhi'),
      align: 'num',
      cell: (r) => <ShareBar ratio={r.hhi} warn={r.hhi >= 0.25} />,
    },
    {
      key: 'suppliers',
      header: t('competition.colSuppliers'),
      align: 'num',
      cell: (r) => count(r.suppliers, locale),
    },
    {
      key: 'contracts',
      header: t('competition.colContracts'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'value',
      header: t('competition.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
  ];

  const pairColumns: Column<CompetitionPair>[] = [
    { key: 'rank', header: '#', isRank: true, cell: (r) => r.rank },
    {
      key: 'authority',
      header: t('competition.colAuthority'),
      isTitle: true,
      cell: (r) => <Link to={`/authorities/${r.authoritySlug}`}>{r.authorityName}</Link>,
    },
    {
      key: 'bidder',
      header: t('competition.colBidder'),
      cell: (r) => <Link to={`/companies/${r.bidderSlug}`}>{r.bidderDisplayName}</Link>,
    },
    {
      key: 'contracts',
      header: t('competition.colContracts'),
      align: 'num',
      cell: (r) => count(r.contracts, locale),
    },
    {
      key: 'value',
      header: t('competition.colValue'),
      align: 'money',
      cell: (r) => money(r.wonEur, locale),
    },
  ];

  const totals: Total[] = [
    {
      num: pct(data.totals.singleOfferShare, 1, locale),
      label: t('competition.totalSingleOfferShare'),
    },
    { num: count(data.totals.singleOffer, locale), label: t('competition.totalSingleOffer') },
    {
      num: pct(data.totals.singleOfferValueShare, 1, locale),
      label: t('competition.totalSingleOfferValueShare'),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('competition.breadcrumbHome'), to: '/' },
          { label: t('competition.breadcrumbCompetition') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('competition.kicker')}
          title={t('competition.title')}
          lede={t('competition.lede')}
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label={t('competition.controlsAria')}
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            {t('competition.sectorLabel')}
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">{t('competition.allSectors')}</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('competition.yearLabel')}
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
            {t('competition.fundingLabel')}
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">{t('competition.fundingAll')}</option>
              <option value="eu">{t('competition.fundingEu')}</option>
              <option value="national">{t('competition.fundingNational')}</option>
            </select>
          </label>
          <label>
            {t('competition.countLabel')}
            <select name="top" defaultValue={sel('top')}>
              <option value="">{t('competition.top20')}</option>
              <option value="50">{t('competition.top50')}</option>
            </select>
          </label>
          <noscript>
            <button type="submit">{t('competition.submit')}</button>
          </noscript>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? t('competition.statusUpdating') : t('competition.statusUpdated')}
        </p>

        {(unknownSector || unknownYear) && (
          <Callout variant="warning" title={t('competition.unknownFilterTitle')}>
            <p style={{ margin: 0 }}>
              {unknownSector && t('competition.unknownSector')}
              {unknownYear && t('competition.unknownYear')}
              {t('competition.unknownFilterSuffix')}
            </p>
          </Callout>
        )}

        <TotalsStrip totals={totals} label={t('competition.totalsLabel')} />

        <Section
          id="single-offer"
          title={
            <>
              {t('competition.singleOfferTitlePre')}
              <em>{t('competition.singleOfferTitleEm')}</em>
            </>
          }
          hint={t('competition.singleOfferHint', { min: data.scope.minContracts })}
        >
          {data.bySingleOffer.length ? (
            <DataTable
              columns={singleOfferColumns}
              rows={data.bySingleOffer}
              getKey={(r) => r.slug}
              caption={t('competition.singleOfferCaption')}
            />
          ) : (
            <p className="muted">{t('competition.emptyState')}</p>
          )}
        </Section>

        <Section
          id="concentration"
          title={
            <>
              {t('competition.concentrationTitlePre')}
              <em>{t('competition.concentrationTitleEm')}</em>
              {t('competition.concentrationTitlePost')}
            </>
          }
          hint={t('competition.concentrationHint')}
        >
          {data.byConcentration.length ? (
            <DataTable
              columns={concentrationColumns}
              rows={data.byConcentration}
              getKey={(r) => r.slug}
              caption={t('competition.concentrationCaption')}
            />
          ) : (
            <p className="muted">{t('competition.emptyState')}</p>
          )}
        </Section>

        <Section
          id="pairs"
          title={
            <>
              {t('competition.pairsTitlePre')}
              <em>{t('competition.pairsTitleEm')}</em>
            </>
          }
          hint={t('competition.pairsHint')}
        >
          {data.topPairs.length ? (
            <DataTable
              columns={pairColumns}
              rows={data.topPairs}
              getKey={(r) => `${r.authoritySlug}-${r.bidderSlug}`}
              caption={t('competition.pairsCaption')}
            />
          ) : (
            <p className="muted">{t('competition.emptyState')}</p>
          )}
        </Section>

        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          {t('competition.footerPre')}
          <Link to="/methodology#glossary">{t('competition.footerLink')}</Link>
          {t('competition.footerPost')}
        </p>
      </main>
    </>
  );
}
