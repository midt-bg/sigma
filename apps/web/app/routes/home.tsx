import { Link } from '../i18n/Link';
import { count, date, money, moneyBare } from '@sigma/shared';
import { getHomeData } from '@sigma/db';
import type { ContractListItem } from '@sigma/api-contract';
import type { Route } from './+types/home';
import { PageHeader } from '../components/PageHeader';
import { SmartSearch } from '../components/SmartSearch';
import { TotalsStrip } from '../components/TotalsStrip';
import { RankedBars } from '../components/RankedBars';
import { SingleOfferPortion } from '../components/SingleOfferPortion';
import { OwnershipChip } from '../components/ui';
import { ANALYTICS_LENSES } from '../lib/analytics-lenses';
import { publicCache } from '../lib/cache';
import { coverageEndYear, coveragePartialNote, coverageRange } from '../lib/coverage';
import { seoMeta } from '../lib/meta';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';

export function meta({ matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/',
    title: t('home.metaTitle'),
    description: t('home.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  // Identical for every visitor between refreshes — the `Cache-Control` above (publicCache(3600))
  // memoises this response at the edge; no separate data cache.
  return getHomeData(env.DB, getLocale(request));
}

function SingleOfferTable({ items, allHref }: { items: ContractListItem[]; allHref: string }) {
  const t = useTranslation();
  const locale = useLocale();
  if (items.length === 0) return <p className="small muted">{t('home.noData')}</p>;
  return (
    <>
      <div className="table-wrap tbl-cards">
        <table>
          <caption className="sr-only">{t('home.singleOfferCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('home.thDate')}</th>
              <th scope="col">{t('home.thContract')}</th>
              <th scope="col">{t('home.thParties')}</th>
              <th scope="col" className="num">
                {t('home.thValue')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="nowrap" data-label={t('home.thDate')}>
                  {date(c.signedAt, locale)}
                </td>
                <td className="cell-title" data-label={t('home.thContract')}>
                  <Link to={`/contracts/${c.id}`}>{c.subject}</Link>
                </td>
                <td data-label={t('home.thParties')}>
                  <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                  {' · '}
                  <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                </td>
                <td className="money" data-label={t('home.thValue')}>
                  {c.valueEur != null ? money(c.valueEur, locale) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted mt-8">
        <Link to={allHref}>{t('home.viewAll')}</Link>
      </p>
    </>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const {
    totals,
    topCompanies,
    topMinistries,
    topMunicipalities,
    recentSingleOffer,
    topSingleOffer,
    singleOffer,
  } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const endYear = coverageEndYear(totals.asOf);
  const range = coverageRange(endYear);
  return (
    <main id="main">
      <div className="hero-panel">
        <PageHeader
          kicker={t('home.heroKicker')}
          title={
            <>
              {t('home.heroTitlePre')}
              <em>{t('home.heroTitleEm')}</em>
              {t('home.heroTitlePost')}
            </>
          }
          lede={t('home.heroLede')}
        >
          <SmartSearch variant="hero" />
        </PageHeader>
        <img
          className="hero-mark"
          src="/hero-mark.png"
          alt=""
          aria-hidden="true"
          width={900}
          height={900}
        />
      </div>

      <TotalsStrip
        label={t('home.totalsLabel')}
        totals={[
          { num: count(totals.contracts, locale), label: t('home.totalsContracts') },
          { num: moneyBare(totals.valueEur, locale), label: t('home.totalsValue') },
          { num: count(totals.authorities, locale), label: t('home.totalsAuthorities') },
          { num: count(totals.bidders, locale), label: t('home.totalsBidders') },
        ]}
      />
      <p className="small muted coverage-note">
        {totals.asOf
          ? t('home.coverageWithLast', {
              note: coveragePartialNote(endYear, locale),
              date: date(totals.asOf, locale),
            })
          : t('home.coverageNoLast', { note: coveragePartialNote(endYear, locale) })}
      </p>

      <section className="section" aria-labelledby="find-yours">
        <h2 id="find-yours">
          {t('home.authoritiesTitlePre')}
          <em>{t('home.authoritiesTitleEm')}</em>
        </h2>
        <p className="section-hint">{t('home.authoritiesHint', { range })}</p>
        <div className="two-col">
          <div>
            <p className="subhead">{t('home.subheadMinistries')}</p>
            <RankedBars items={topMinistries} />
          </div>
          <div>
            <p className="subhead">{t('home.subheadMunicipalities')}</p>
            <RankedBars items={topMunicipalities} />
            <p className="small muted mt-8">
              <Link to="/authorities">{t('home.authoritiesViewAll')}</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="top-bene">
        <h2 id="top-bene">
          {t('home.companiesTitlePre')}
          <em>{t('home.companiesTitleEm')}</em>
        </h2>
        <p className="section-hint">
          {t('home.companiesHint', { range })}
          <Link to="/companies">{t('home.companiesViewAll')}</Link>
        </p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('home.companiesCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('home.thRank')}</th>
                <th scope="col">{t('home.thCompany')}</th>
                <th scope="col" className="num">
                  {t('home.thWon')}
                </th>
                <th scope="col" className="num">
                  {t('home.thContracts')}
                </th>
                <th scope="col" className="num">
                  {t('home.thAuthorities')}
                </th>
              </tr>
            </thead>
            <tbody>
              {topCompanies.map((c, i) => (
                <tr key={c.slug}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link to={`/companies/${c.slug}`}>{c.displayName}</Link>
                    <br />
                    <span className="small muted">
                      {c.kind === 'consortium' ? (
                        <span className="flag soft">{t('home.consortiumFlag')}</span>
                      ) : (
                        <>
                          {c.eik ? t('home.eik', { eik: c.eik }) : t('home.unconfirmedEik')}
                          {c.sector ? ` · ${c.sector.short}` : ''}
                        </>
                      )}
                      {c.ownershipKind && (
                        <>
                          {' '}
                          <OwnershipChip kind={c.ownershipKind} />
                        </>
                      )}
                    </span>
                  </td>
                  <td className="money">{money(c.wonEur, locale)}</td>
                  <td className="money">{count(c.contracts, locale)}</td>
                  <td className="money">{count(c.authorities, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="single-offer">
        <h2 id="single-offer">
          {t('home.singleOfferTitlePre')}
          <em>{t('home.singleOfferTitleEm')}</em>
        </h2>
        <p className="section-hint">{t('home.singleOfferHint')}</p>
        <SingleOfferPortion valueEur={singleOffer.valueEur} totalEur={totals.valueEur} />
        <div className="tabset" role="radiogroup" aria-label={t('home.singleOfferTabsLabel')}>
          <input
            type="radio"
            name="single-offer"
            id="so-recent"
            className="tab-input"
            defaultChecked
          />
          <input type="radio" name="single-offer" id="so-top" className="tab-input" />
          <div className="tab-labels">
            <label id="tab-so-recent" htmlFor="so-recent">
              {t('home.tabRecent')}
            </label>
            <label id="tab-so-top" htmlFor="so-top">
              {t('home.tabTop')}
            </label>
          </div>
          <div className="tab-panel" data-tab="recent" role="group" aria-labelledby="tab-so-recent">
            <SingleOfferTable
              items={recentSingleOffer}
              allHref="/contracts?bids=1&sort=date-desc"
            />
          </div>
          <div className="tab-panel" data-tab="top" role="group" aria-labelledby="tab-so-top">
            <SingleOfferTable items={topSingleOffer} allHref="/contracts?bids=1&sort=value-desc" />
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="analytics">
        <h2 id="analytics">
          <Link to="/analytics">{t('home.analyticsTitle')}</Link>
        </h2>
        <p className="section-hint">{t('home.analyticsHint')}</p>
        <div className="tiles">
          {ANALYTICS_LENSES.map((item) => (
            <article className="tile" key={item.href}>
              <p className="kicker info">{t('home.analyticsKicker')}</p>
              <h3>
                <Link to={item.href}>{t(`analytics.lens.${item.key}.title`)}</Link>
              </h3>
              <p className="desc">{t(`analytics.lens.${item.key}.desc`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="how">
        <h2 id="how">
          {t('home.howTitlePre')}
          <em>{t('home.howTitleEm')}</em>
        </h2>
        <div className="two-col">
          <div>
            <h3 className="mb-8">{t('home.howWhatTitle')}</h3>
            <p>{t('home.howWhatBody')}</p>
          </div>
          <div>
            <h3 className="mb-8">{t('home.howUnitTitle')}</h3>
            <p>
              {t('home.howUnitBody')}
              <Link to="/methodology">{t('home.methodologyLink')}</Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
