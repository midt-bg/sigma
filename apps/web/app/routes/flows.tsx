import { Form, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { Link } from '../i18n/Link';
import { count, money } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { getFlows } from '@sigma/db';
import type { Route } from './+types/flows';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { SankeyDiagram } from '../components/SankeyDiagram';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';
import { seoMeta } from '../lib/meta';
import { singleSelectFilters } from '../lib/filters';

export function meta({ matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: location.pathname,
    title: t('flows.metaTitle'),
    description: t('flows.metaDescription'),
  });
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
  const data = await getFlows(db, { sector, year, funding, top }, getLocale(request));
  return { data, coverage, years, unknownSector, unknownYear };
}

export default function Flows({ loaderData }: Route.ComponentProps) {
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('flows.breadcrumbHome'), to: '/' },
          { label: t('flows.breadcrumbFlows') },
        ]}
      />
      <main id="main">
        <PageHeader kicker={t('flows.kicker')} title={t('flows.title')} lede={t('flows.lede')} />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label={t('flows.controlsAria')}
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            {t('flows.sectorLabel')}
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">{t('flows.allSectors')}</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('flows.yearLabel')}
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
            {t('flows.fundingLabel')}
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">{t('flows.fundingAll')}</option>
              <option value="eu">{t('flows.fundingEu')}</option>
              <option value="national">{t('flows.fundingNational')}</option>
            </select>
          </label>
          <label>
            {t('flows.topLabel')}
            <select name="top" defaultValue={sel('top') || '20'}>
              <option value="20">{t('flows.top20')}</option>
              <option value="50">{t('flows.top50')}</option>
            </select>
          </label>
        </Form>

        {/* Filters auto-submit on change; announce the swap for screen-reader users (WCAG 4.1.3). */}
        <p className="sr-only" role="status">
          {navigating ? t('flows.statusUpdating') : t('flows.statusUpdated')}
        </p>

        {unknownSector || unknownYear ? (
          <Callout variant="warning" title={t('flows.emptyTitle')}>
            {unknownSector ? t('flows.emptySector') : t('flows.emptyYear', { range })}{' '}
            {t('flows.emptySuffixPre')} <Link to="/flows">{t('flows.emptyLink')}</Link>{' '}
            {t('flows.emptySuffixPost')}
          </Callout>
        ) : (
          <>
            <Callout>
              <strong>{t('flows.howToReadStrong')}</strong> {t('flows.howToRead')}
            </Callout>

            <SankeyDiagram layout={data.sankey} />

            <div className="flow-tooltip">
              <strong>{t('flows.tooltipTitle')}</strong>
              {t('flows.tooltipBody')}
            </div>
          </>
        )}

        <Section id="scenarios" title={t('flows.scenariosTitle')} hint={t('flows.scenariosHint')}>
          <div className="tiles">
            {[
              {
                href: '/flows?sector=45',
                title: t('flows.scenarioConstructionTitle'),
                desc: t('flows.scenarioConstructionDesc'),
              },
              {
                href: '/flows?sector=33',
                title: t('flows.scenarioMedicineTitle'),
                desc: t('flows.scenarioMedicineDesc'),
              },
              {
                href: '/flows?sector=09',
                title: t('flows.scenarioEnergyTitle'),
                desc: t('flows.scenarioEnergyDesc'),
              },
              {
                href: '/flows?funding=eu',
                title: t('flows.scenarioEuTitle'),
                desc: t('flows.scenarioEuDesc'),
              },
            ].map((tile) => (
              <article className="tile" key={tile.href}>
                <p className="kicker info">{t('flows.scenario')}</p>
                <h3>
                  <Link to={tile.href}>{tile.title}</Link>
                </h3>
                <p className="desc">{tile.desc}</p>
              </article>
            ))}
          </div>
        </Section>

        {!unknownSector && !unknownYear && (
          <Section
            id="top-flows"
            title={t('flows.tableTitle', { top: data.scope.top })}
            hint={t('flows.tableHint')}
          >
            <div className="table-wrap tbl-cards">
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t('flows.colAuthority')}</th>
                    <th scope="col">{t('flows.colCompany')}</th>
                    <th scope="col" className="num">
                      {t('flows.colSum')}
                    </th>
                    <th scope="col" className="num">
                      {t('flows.colContracts')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.pairs.map((p) => (
                    <tr key={`${p.authoritySlug}-${p.bidderSlug}`}>
                      <td className="rank cell-rank" data-label="#">
                        {p.rank}
                      </td>
                      <td className="cell-title" data-label={t('flows.colAuthority')}>
                        <Link to={`/authorities/${p.authoritySlug}`}>{p.authorityName}</Link>
                      </td>
                      <td data-label={t('flows.colCompany')}>
                        <Link to={`/companies/${p.bidderSlug}`}>{p.bidderDisplayName}</Link>
                      </td>
                      <td className="money" data-label={t('flows.colSum')}>
                        {money(p.wonEur, locale)}
                      </td>
                      <td className="money" data-label={t('flows.colContracts')}>
                        {count(p.contracts, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted mt-s3">
              {t('flows.tableFootPre')}{' '}
              <Link to="/contracts?sort=value-desc">{t('flows.tableFootLink')}</Link>
            </p>
          </Section>
        )}
      </main>
    </>
  );
}
