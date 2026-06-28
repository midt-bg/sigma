import { Link } from '../i18n/Link';
import { count, date, money, pct } from '@sigma/shared';
import { getMethodologyStats } from '@sigma/db';
import type { Route } from './+types/methodology';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Callout, Flag } from '../components/ui';
import { publicCache } from '../lib/cache';
import { START_YEAR, coverageEndYear } from '../lib/coverage';
import { seoMeta } from '../lib/meta';
import { useLocale, useTranslation } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';

export function meta({ matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: location.pathname,
    title: t('methodology.metaTitle'),
    description: t('methodology.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

// Pull the live corpus figures so the credibility-critical copy matches reality, not hard-coded numbers.
export async function loader({ context }: Route.LoaderArgs) {
  return getMethodologyStats(context.cloudflare.env.DB);
}

const TOC_IDS = [
  'what',
  'source',
  'unit',
  'principles',
  'glossary',
  'money',
  'identity',
  'gaps',
  'export',
  'contact',
] as const;

type GapRow = [string, string, 'has' | 'gap', string, 'info' | 'soft' | 'none'];

export default function Methodology({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  const locale = useLocale();
  const totals = loaderData.totals;
  const endYear = coverageEndYear(totals.asOf);
  const period =
    loaderData.firstDate && totals.asOf
      ? t('methodology.period', { first: loaderData.firstDate.slice(0, 4), end: endYear })
      : t('methodology.period', { first: START_YEAR, end: endYear });
  const gaps: GapRow[] = [
    [
      t('methodology.gaps.instField'),
      t('methodology.gaps.instSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.companyField'),
      t('methodology.gaps.companySrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.valueField'),
      t('methodology.gaps.valueSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.unpField'),
      t('methodology.gaps.unpSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.sectorField'),
      t('methodology.gaps.sectorSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.objectField'),
      t('methodology.gaps.objectSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.euFundField'),
      t('methodology.gaps.euFundSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.instTypeField'),
      t('methodology.gaps.instTypeSrc'),
      'has',
      t('methodology.gaps.badgeYes'),
      'info',
    ],
    [
      t('methodology.gaps.bidsField'),
      t('methodology.gaps.bidsSrc'),
      'gap',
      `≈${pct(loaderData.coverage.bids, 0, locale)}`,
      'soft',
    ],
    [
      t('methodology.gaps.euProgField'),
      t('methodology.gaps.euProgSrc'),
      'gap',
      `≈${pct(loaderData.coverage.eu, 0, locale)}`,
      'soft',
    ],
    [
      t('methodology.gaps.durationField'),
      t('methodology.gaps.durationSrc'),
      'gap',
      `≈${pct(loaderData.coverage.duration, 0, locale)}`,
      'soft',
    ],
    [
      t('methodology.gaps.currentValField'),
      t('methodology.gaps.currentValSrc'),
      'gap',
      t('methodology.gaps.badgeOnAnnex'),
      'soft',
    ],
    [
      t('methodology.gaps.lotLinkField'),
      t('methodology.gaps.lotLinkSrc'),
      'gap',
      `≈${pct(loaderData.coverage.lot, 0, locale)}`,
      'soft',
    ],
    [
      t('methodology.gaps.seatField'),
      t('methodology.gaps.seatSrc'),
      'gap',
      t('methodology.gaps.badgeWhenAvailable'),
      'soft',
    ],
    [
      t('methodology.gaps.secondaryCpvField'),
      t('methodology.gaps.dash'),
      'gap',
      t('methodology.gaps.badgeNo'),
      'none',
    ],
    [
      t('methodology.gaps.bidValuesField'),
      t('methodology.gaps.dash'),
      'gap',
      t('methodology.gaps.badgeNo'),
      'none',
    ],
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('methodology.breadcrumbHome'), to: '/' },
          { label: t('methodology.breadcrumbCurrent') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('methodology.kicker')}
          title={t('methodology.title')}
          lede={t('methodology.lede')}
        />
        {(totals.asOf || totals.refreshedAt) && (
          <p className="doc-version">
            {t('methodology.edition')}
            {totals.asOf
              ? t('methodology.editionLastContract', { date: date(totals.asOf, locale) })
              : ''}
            {totals.refreshedAt
              ? t('methodology.editionRefreshed', { date: date(totals.refreshedAt, locale) })
              : ''}
          </p>
        )}

        <div className="split">
          <aside className="toc" aria-label={t('methodology.tocAria')}>
            <p className="toc-title">{t('methodology.tocTitle')}</p>
            <ol>
              {TOC_IDS.map((id, i) => (
                <li key={id}>
                  <span className="n">{i + 1}</span>
                  <a href={`#${id}`}>{t(`methodology.toc.${id}` as 'methodology.toc.what')}</a>
                </li>
              ))}
            </ol>
          </aside>

          <div>
            <section className="section" aria-labelledby="what">
              <h2 id="what">{t('methodology.what.heading')}</h2>
              <p>
                {t('methodology.what.intro1')}
                <em>{t('methodology.what.introEm')}</em>
                {t('methodology.what.intro2')}
                <strong>{t('methodology.what.introStrong')}</strong>
                {t('methodology.what.intro3')}
              </p>
              <ul>
                <li>
                  <strong>{t('methodology.what.instStrong')}</strong>
                  {t('methodology.what.instText')}
                </li>
                <li>
                  <strong>{t('methodology.what.companyStrong')}</strong>
                  {t('methodology.what.companyText')}
                </li>
                <li>
                  <strong>{t('methodology.what.contractStrong')}</strong>
                  {t('methodology.what.contractText')}
                </li>
              </ul>
              <p>{t('methodology.what.readOnly')}</p>
              <Callout title={t('methodology.what.calloutTitle')}>
                <p className="m-0">{t('methodology.what.calloutBody')}</p>
              </Callout>
            </section>

            <section className="section" aria-labelledby="source">
              <h2 id="source">{t('methodology.source.heading')}</h2>
              <dl className="facts">
                <div className="row">
                  <dt>{t('methodology.source.primaryDt')}</dt>
                  <dd>{t('methodology.source.primaryDd')}</dd>
                </div>
                <div className="row">
                  <dt>{t('methodology.source.namesDt')}</dt>
                  <dd>{t('methodology.source.namesDd')}</dd>
                </div>
                <div className="row">
                  <dt>{t('methodology.source.periodDt')}</dt>
                  <dd>{t('methodology.source.periodDd', { period })}</dd>
                </div>
                <div className="row">
                  <dt>{t('methodology.source.sectorsDt')}</dt>
                  <dd>
                    <strong>{t('methodology.source.sectorsDdStrong')}</strong>
                    {t('methodology.source.sectorsDd', { sectors: loaderData.sectors })}
                  </dd>
                </div>
                <div className="row">
                  <dt>{t('methodology.source.recordsDt')}</dt>
                  <dd>
                    {t('methodology.source.recordsDd', {
                      contracts: count(totals.contracts, locale),
                      authorities: count(totals.authorities, locale),
                      bidders: count(totals.bidders, locale),
                    })}
                    <strong>{money(totals.valueEur, locale)}</strong>
                    {totals.asOf
                      ? t('methodology.source.recordsAsOf', { date: date(totals.asOf, locale) })
                      : ''}
                    {totals.refreshedAt
                      ? t('methodology.source.recordsRefreshed', {
                          date: date(totals.refreshedAt, locale),
                        })
                      : ''}
                  </dd>
                </div>
                <div className="row">
                  <dt>
                    {t('methodology.source.excludedDtBefore')}
                    <em>{t('methodology.source.excludedDtEm')}</em>
                    {t('methodology.source.excludedDtAfter')}
                  </dt>
                  <dd>{t('methodology.source.excludedDd')}</dd>
                </div>
                <div className="row">
                  <dt>{t('methodology.source.suspectDt')}</dt>
                  <dd>
                    {t('methodology.source.suspectDd', { suspect: count(totals.suspect, locale) })}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="section" aria-labelledby="unit">
              <h2 id="unit">{t('methodology.unit.heading')}</h2>
              <p>
                {t('methodology.unit.body1')}
                <strong>{t('methodology.unit.bodyStrong')}</strong>
                {t('methodology.unit.body2')}
              </p>
              <Callout title={t('methodology.unit.calloutTitle')}>
                <p className="m-0">
                  {t('methodology.unit.calloutBody1')}
                  <strong>{t('methodology.unit.calloutBodyStrong1')}</strong>
                  {t('methodology.unit.calloutBody2')}
                  <strong>{t('methodology.unit.calloutBodyStrong2')}</strong>
                  {t('methodology.unit.calloutBody3')}
                </p>
              </Callout>
            </section>

            <section className="section" aria-labelledby="principles">
              <h2 id="principles">{t('methodology.principles.heading')}</h2>
              <ol className="principles">
                <li>
                  <strong>{t('methodology.principles.p1Strong')}</strong>
                  {t('methodology.principles.p1Text')}
                </li>
                <li>
                  <strong>{t('methodology.principles.p2Strong')}</strong>
                  {t('methodology.principles.p2Text')}
                </li>
                <li>
                  <strong>{t('methodology.principles.p3Strong')}</strong>
                  {t('methodology.principles.p3Text')}
                </li>
                <li>
                  <strong>{t('methodology.principles.p4Strong')}</strong>
                  {t('methodology.principles.p4Text')}
                </li>
                <li>
                  <strong>{t('methodology.principles.p5Strong')}</strong>
                  {t('methodology.principles.p5Text')}
                </li>
                <li>
                  <strong>{t('methodology.principles.p6Strong')}</strong>
                  {t('methodology.principles.p6Text')}
                </li>
              </ol>
            </section>

            <section className="section" aria-labelledby="glossary">
              <h2 id="glossary">{t('methodology.glossary.heading')}</h2>
              <dl className="glossary">
                <dt>{t('methodology.glossary.authorityTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.authorityDef')}</p>
                  <span className="src">{t('methodology.glossary.authoritySrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.companyTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.companyDef')}</p>
                  <span className="src">{t('methodology.glossary.companySrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.lotTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.lotDef')}</p>
                  <span className="src">{t('methodology.glossary.lotSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.unpTerm')}</dt>
                <dd>
                  <p>
                    {t('methodology.glossary.unpDef1')}
                    <span className="mono">{t('methodology.glossary.unpExample')}</span>
                    {t('methodology.glossary.unpDef2')}
                  </p>
                  <span className="src">{t('methodology.glossary.unpSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.sectorTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.sectorDef')}</p>
                  <span className="src">{t('methodology.glossary.sectorSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.consortiumTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.consortiumDef')}</p>
                  <span className="src">{t('methodology.glossary.consortiumSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.flowTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.flowDef')}</p>
                  <span className="src">{t('methodology.glossary.flowSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.networkTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.networkDef')}</p>
                  <span className="src">{t('methodology.glossary.networkSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.signedTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.signedDef')}</p>
                  <span className="src">{t('methodology.glossary.signedSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.regionTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.regionDef')}</p>
                  <span className="src">{t('methodology.glossary.regionSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.singleBidTerm')}</dt>
                <dd>
                  <p>
                    {t('methodology.glossary.singleBidDef1')}
                    <strong>{t('methodology.glossary.singleBidStrong')}</strong>
                    {t('methodology.glossary.singleBidDef2')}
                  </p>
                  <span className="src">{t('methodology.glossary.singleBidSrc')}</span>
                </dd>
                <dt>{t('methodology.glossary.hhiTerm')}</dt>
                <dd>
                  <p>{t('methodology.glossary.hhiDef')}</p>
                  <span className="src">{t('methodology.glossary.hhiSrc')}</span>
                </dd>
              </dl>
            </section>

            <section className="section" aria-labelledby="money">
              <h2 id="money">{t('methodology.money.heading')}</h2>
              <p>
                {t('methodology.money.p1a')}
                <strong>{t('methodology.money.p1Strong1')}</strong>
                {t('methodology.money.p1b')}
                <strong>{t('methodology.money.p1Strong2')}</strong>
                {t('methodology.money.p1c')}
                <strong>{t('methodology.money.p1Strong3')}</strong>
                {t('methodology.money.p1d')}
              </p>
              <p>
                {t('methodology.money.p2a')}
                <strong>{t('methodology.money.p2Strong1')}</strong>
                {t('methodology.money.p2b')}
                <strong>{t('methodology.money.p2Strong2')}</strong>
                {t('methodology.money.p2c')}
              </p>
              <p>{t('methodology.money.p3')}</p>
            </section>

            <section className="section" aria-labelledby="identity">
              <h2 id="identity">{t('methodology.identity.heading')}</h2>
              <p>{t('methodology.identity.intro')}</p>
              <ul>
                <li>
                  <strong>{t('methodology.identity.instStrong')}</strong>
                  {t('methodology.identity.instText')}
                </li>
                <li>
                  <strong>{t('methodology.identity.companyStrong')}</strong>
                  {t('methodology.identity.companyText')}
                </li>
                <li>
                  <strong>{t('methodology.identity.namesStrong')}</strong>
                  {t('methodology.identity.namesText')}
                </li>
                <li>
                  <strong>{t('methodology.identity.unpStrong')}</strong>
                  {t('methodology.identity.unpText')}
                </li>
              </ul>
            </section>

            <section className="section" aria-labelledby="gaps">
              <h2 id="gaps">{t('methodology.gapsSection.heading')}</h2>
              <p className="section-hint">{t('methodology.gapsSection.hint')}</p>
              <div className="table-wrap">
                <table className="gap-table">
                  <caption className="sr-only">{t('methodology.gapsSection.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('methodology.gapsSection.colField')}</th>
                      <th scope="col">{t('methodology.gapsSection.colSource')}</th>
                      <th scope="col">{t('methodology.gapsSection.colReady')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map(([field, src, cls, badge, variant]) => (
                      <tr className={cls} key={field}>
                        <td>{field}</td>
                        <td>{src}</td>
                        <td>
                          {variant === 'none' ? (
                            <Flag>{badge}</Flag>
                          ) : (
                            <Flag variant={variant}>{badge}</Flag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted mt-s3">
                <strong>{t('methodology.gapsSection.footStrong1')}</strong>
                {t('methodology.gapsSection.footMid1')}
                <strong>{t('methodology.gapsSection.footStrong2')}</strong>
                {t('methodology.gapsSection.footMid2')}
                <strong>{t('methodology.gapsSection.footStrong3')}</strong>
                {t('methodology.gapsSection.footText')}
              </p>
            </section>

            <section className="section" aria-labelledby="export">
              <h2 id="export">{t('methodology.exportSection.heading')}</h2>
              <p>{t('methodology.exportSection.intro')}</p>
              <ul>
                <li>
                  <Link to="/authorities">{t('methodology.exportSection.listAuthorities')}</Link>
                  {t('methodology.exportSection.listSep1')}
                  <Link to="/companies">{t('methodology.exportSection.listCompanies')}</Link>
                  {t('methodology.exportSection.listSep2')}
                  <Link to="/contracts">{t('methodology.exportSection.listContracts')}</Link>
                  {t('methodology.exportSection.listSuffix')}
                </li>
                <li>{t('methodology.exportSection.jsonItem')}</li>
              </ul>
              <p>{t('methodology.exportSection.noApi')}</p>
            </section>

            <section className="section" aria-labelledby="contact">
              <h2 id="contact">{t('methodology.contact.heading')}</h2>
              <p>{t('methodology.contact.p1')}</p>
              <p>
                {t('methodology.contact.p2a')}
                <em>{t('methodology.contact.p2Em')}</em>
                {t('methodology.contact.p2b')}
              </p>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
