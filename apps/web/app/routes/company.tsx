import { Link } from '../i18n/Link';
import {
  count,
  decimal,
  isNaturalPersonProfileName,
  money,
  moneyBare,
  pct,
  periodRange,
  plural,
} from '@sigma/shared';
import { bidderIdFromSlug, getCompany, getEntityNetwork, getSpendingTrend } from '@sigma/db';
import type { Route } from './+types/company';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { useTranslation, useLocale } from '../i18n/context';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { DataTable } from '../components/DataTable';
import { TrendChart } from '../components/TrendChart';
import { NetworkGraph } from '../components/NetworkGraph';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { ShareBar, Chip, OwnershipChip, Section, ExternalEikLink } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta } from '../lib/coverage';
import { networkColumns, networkRows, trendYearColumns } from '../lib/entity-tables';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

function isSingleNaturalPersonProfile(kind: string, legalForm: string | null): boolean {
  if (kind === 'consortium' || !legalForm) return false;
  const normalized = legalForm.trim().toUpperCase();
  return (
    normalized === 'ЕТ' ||
    normalized === 'ET' ||
    normalized.includes('ЕДНОЛИЧЕН ТЪРГОВЕЦ') ||
    normalized.includes('SOLE TRADER') ||
    normalized.includes('INDIVIDUAL')
  );
}

export function meta({ data, params, location, matches }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  const name = data?.company.displayName ?? t('company.fallbackName');
  const range = coverageRange(data?.coverage.coverageEndYear);
  const metaTags = seoMeta({
    matches,
    path: `/companies/${params.eik}`,
    title: t('company.metaTitle', { name }),
    description: t('company.metaDescription', { name, range }),
  });
  if (
    data?.company &&
    (isSingleNaturalPersonProfile(data.company.kind, data.company.legalForm) ||
      isNaturalPersonProfileName(data.company.displayName) ||
      (data.company.kind === 'consortium' && Boolean(data.company.membershipNote)))
  ) {
    metaTags.push({ name: 'robots', content: 'noindex' });
  }
  return metaTags;
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!params.eik?.trim()) throw new Response('Not Found', { status: 404 });
  const id = bidderIdFromSlug(params.eik);
  if (!id) throw new Response('Not Found', { status: 404 });
  const locale = getLocale(request);
  const db = context.cloudflare.env.DB;
  return withDbRetry(async () => {
    const [company, coverage, trend, network] = await Promise.all([
      getCompany(db, id, locale),
      getCoverageMeta(db),
      getSpendingTrend(
        db,
        { bidderId: id, granularity: 'month' },
        { includeSectors: false },
        locale,
      ),
      getEntityNetwork(db, { kind: 'company', id }, { includeCenterOptions: false }, locale),
    ]);
    if (!company) throw new Response('Not Found', { status: 404 });
    return { company, coverage, trend, network };
  });
}

export default function Company({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  const locale = useLocale();
  const c = loaderData.company;
  const { trend, network } = loaderData;
  const range = coverageRange(loaderData.coverage.coverageEndYear);
  const noEikCompany = !c.isConsortium && !c.hasEik;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('company.breadcrumbHome'), to: '/' },
          { label: t('company.breadcrumbCompanies'), to: '/companies' },
          { label: c.displayName },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              {c.isConsortium ? t('company.kindConsortium') : t('company.kindCompany')}
              {noEikCompany && (
                <>
                  {' '}
                  · <Chip>{t('company.noEik')}</Chip>
                </>
              )}
              {c.ownershipKind && (
                <>
                  {' '}
                  · <OwnershipChip kind={c.ownershipKind} />
                </>
              )}
              {c.sector && (
                <>
                  {' '}
                  · <Chip>{c.sector.short}</Chip>
                </>
              )}
              {c.hasEik && c.eik && (
                <>
                  {' '}
                  · {t('company.eik')}&nbsp;{c.eik}
                  <ExternalEikLink eik={c.eik} />
                </>
              )}
            </>
          }
          title={c.displayName}
          lede={
            c.isConsortium
              ? t('company.ledeConsortium', { range })
              : t('company.ledeCompany', { range })
          }
        />

        <FactsList
          label={t('company.factsLabel')}
          rows={[
            { term: t('company.factTotalWon'), value: money(c.wonEur, locale) },
            c.sector && {
              term: t('company.factMainSector'),
              value: `${c.sector.label} (CPV ${c.sector.code})`,
              sub:
                c.sectorSharePct != null
                  ? t('company.factSectorShare', { pct: pct(c.sectorSharePct, 1, locale) })
                  : undefined,
            },
            { term: t('company.factContracts'), value: count(c.contracts, locale) },
            { term: t('company.factPayingAuthorities'), value: count(c.authorities, locale) },
            {
              term: t('company.factPeriod'),
              value: periodRange(c.periodFirst, c.periodLast, locale),
            },
            { term: t('company.factEuShare'), value: pct(c.euSharePct, 1, locale) },
            c.avgBids != null && {
              term: t('company.factAvgBids'),
              value: decimal(c.avgBids, locale),
            },
            {
              term: t('company.factEntityType'),
              value: c.isConsortium ? t('company.entityConsortium') : t('company.entityCompany'),
              sub: c.isConsortium
                ? t('company.entitySubConsortium')
                : noEikCompany
                  ? t('company.entitySubNoEik')
                  : undefined,
            },
            c.settlement && {
              term: t('company.factSeat'),
              value: c.settlement,
              sub: c.region ?? undefined,
            },
            c.suspect > 0 && {
              term: t('company.factUnverifiedValue'),
              value: `${count(c.suspect, locale)} ${plural(c.suspect, t('company.contracts_one'), t('company.contracts_many'), locale)}`,
              sub: t('company.unverifiedValueSub'),
            },
          ]}
        />

        <Section
          id="trend"
          title={t('company.trendTitle')}
          hint={t('company.trendHint', { name: c.displayName })}
        >
          {trend.points.length >= 2 ? (
            <>
              <TrendChart points={trend.points} granularity={trend.granularity} />
              <div className="mt-8">
                <DataTable
                  columns={trendYearColumns(t, locale)}
                  rows={trend.years}
                  getKey={(r) => r.year}
                  caption={t('company.trendCaption')}
                />
              </div>
            </>
          ) : (
            <p className="muted">{t('company.trendEmpty')}</p>
          )}
        </Section>

        <Section
          id="network"
          title={t('company.networkTitle')}
          hint={
            <span>
              {t('company.networkHint', { name: c.displayName })}{' '}
              <Link to={`/network?center=c:${c.slug}`}>{t('company.networkFullLink')}</Link>
            </span>
          }
        >
          {network.center && network.nodes.length >= 2 ? (
            <>
              <NetworkGraph data={network} />
              <div className="sr-only">
                <DataTable
                  columns={networkColumns(t, locale)}
                  rows={networkRows(network)}
                  getKey={(r) => `${r.from}-${r.to}`}
                  caption={t('company.networkCaption')}
                />
              </div>
            </>
          ) : (
            <p className="muted">{t('company.networkEmpty')}</p>
          )}
        </Section>

        {/* Consortium membership. Shown only when the source row gave us something to break out
            (a `;`-list or the rare free-text dump). Plain companies and one-name "ИНТЕРБОЛГАРСТРОЙ
            ДЗЗД"-style rows skip the section — the kind=обединение badge above already says it.
            Per-member ЕИК / profile link is deliberately NOT surfaced even though `eik` /
            `resolvedSlug` are carried on the type — we don't have the data in v1 (parked on the
            Trade Register backfill), and labelling every row „ЕИК неустановен" turned into UI
            noise rather than information. When `resolvedSlug` lands the name will silently become
            a <Link>; until then we just show the names. */}
        {(c.participants.length > 0 || c.membershipNote) && (
          <Section
            id="participants"
            title={
              c.participants.length > 0
                ? t('company.participantsTitle', { count: count(c.participants.length, locale) })
                : t('company.participantsDescriptionTitle')
            }
            hint={
              c.participants.length > 0
                ? t('company.participantsHint')
                : t('company.participantsDescriptionHint')
            }
          >
            {c.participants.length > 0 ? (
              <ol className="participants-list">
                {c.participants.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    {p.resolvedSlug ? (
                      // Already linked to a real company profile (post-TR resolution).
                      <Link to={`/companies/${p.resolvedSlug}`}>{p.name}</Link>
                    ) : (
                      p.name
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <blockquote className="empty-quote">{c.membershipNote}</blockquote>
            )}
          </Section>
        )}

        <Section
          id="from"
          title={t('company.fromTitle')}
          hint={t('company.fromHint', { name: c.displayName.replace(/\.$/, '') })}
        >
          <div className="table-wrap tbl-cards">
            <table>
              <caption className="sr-only">{t('company.fromCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('company.colRank')}</th>
                  <th scope="col">{t('company.colAuthority')}</th>
                  <th scope="col" className="num">
                    {t('company.colPaidToCompany')}
                  </th>
                  <th scope="col" className="num">
                    {t('company.colContracts')}
                  </th>
                  <th scope="col">{t('company.colShareOfWon')}</th>
                </tr>
              </thead>
              <tbody>
                {c.topAuthorities.map((a, i) => (
                  <tr key={a.slug}>
                    <td className="rank cell-rank" data-label={t('company.colRank')}>
                      {i + 1}
                    </td>
                    <td className="cell-title" data-label={t('company.colAuthority')}>
                      <Link to={`/authorities/${a.slug}`}>{a.name}</Link>
                    </td>
                    <td className="money" data-label={t('company.labelPaid')}>
                      {money(a.paidEur, locale)}
                    </td>
                    <td className="money" data-label={t('company.colContracts')}>
                      {count(a.contracts, locale)}
                    </td>
                    <td data-label={t('company.labelShare')}>
                      <ShareBar ratio={a.sharePct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.moreAuthorities > 0 && (
            <p className="small muted mt-s3">
              <Link to={`/contracts?bidder=${c.slug}`}>
                {t('company.moreAuthorities', { count: count(c.moreAuthorities, locale) })}
              </Link>
            </p>
          )}
        </Section>

        <div className="two-col">
          <Section id="how-win" title={t('company.howWinTitle')} hint={t('company.howWinHint')}>
            <StackedBar slices={c.procedureMix.filter((s) => s.sharePct >= 0.0005)} />
          </Section>

          <Section id="bids" title={t('company.bidsTitle')} hint={t('company.bidsHint')}>
            <table>
              <caption className="sr-only">{t('company.bidsCaption')}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">{t('company.bidsColBids')}</th>
                  <th scope="col">{t('company.bidsColTenders')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{t('company.bidsOne')}</td>
                  <td className="money">
                    {count(c.bids.one, locale)} {t('company.tenders')}
                  </td>
                </tr>
                <tr>
                  <td>{t('company.bidsTwo')}</td>
                  <td className="money">
                    {count(c.bids.two, locale)} {t('company.tenders')}
                  </td>
                </tr>
                <tr>
                  <td>{t('company.bidsThree')}</td>
                  <td className="money">
                    {count(c.bids.three, locale)} {t('company.tenders')}
                  </td>
                </tr>
                <tr>
                  <td>{t('company.bidsFourPlus')}</td>
                  <td className="money">
                    {count(c.bids.fourPlus, locale)} {t('company.tenders')}
                  </td>
                </tr>
                {c.bids.unknown > 0 && (
                  <tr>
                    <td className="muted">{t('company.bidsNoData')}</td>
                    <td className="money muted">
                      {count(c.bids.unknown, locale)} {t('company.tenders')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>
        </div>

        <Section
          id="latest"
          title={t('company.contractsTitle')}
          hint={
            <span>
              {t('company.contractsHint', {
                shown: Math.min(Math.max(c.recentContracts.length, c.topContracts.length), 7),
                total: count(c.contracts, locale),
                word: plural(
                  c.contracts,
                  t('company.contracts_one'),
                  t('company.contracts_many'),
                  locale,
                ),
              })}
            </span>
          }
        >
          <div className="tabset" role="radiogroup" aria-label={t('company.contractsSortLabel')}>
            <input
              type="radio"
              name="company-contracts"
              id="company-recent"
              className="tab-input"
              defaultChecked
            />
            <input type="radio" name="company-contracts" id="company-top" className="tab-input" />
            <div className="tab-labels">
              <label id="tab-company-recent" htmlFor="company-recent">
                {t('company.tabNewest')}
              </label>
              <label id="tab-company-top" htmlFor="company-top">
                {t('company.tabLargest')}
              </label>
            </div>
            <div
              className="tab-panel"
              data-tab="recent"
              role="group"
              aria-labelledby="tab-company-recent"
            >
              <ContractMiniTable items={c.recentContracts} counterparty="authority" />
            </div>
            <div
              className="tab-panel"
              data-tab="top"
              role="group"
              aria-labelledby="tab-company-top"
            >
              <ContractMiniTable items={c.topContracts} counterparty="authority" />
            </div>
          </div>
          <p className="small muted mt-8">
            <Link to={`/contracts?bidder=${c.slug}`}>{t('company.viewAllCsv')}</Link>
          </p>
        </Section>
      </main>
    </>
  );
}
