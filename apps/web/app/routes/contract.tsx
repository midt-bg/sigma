import { Link } from '../i18n/Link';
import type { Locale } from '@sigma/shared';
import { count, longDate, money, plural, signedPct } from '@sigma/shared';
import { contractIdFromSlug, getContract } from '@sigma/db';
import type { ContractDetail } from '@sigma/api-contract';
import type { Route } from './+types/contract';
import { makeT, type TFunction } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { useTranslation, useLocale } from '../i18n/context';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { Chip, Flag, Section, ExternalEikLink } from '../components/ui';
import { RiskIndicators } from '../components/RiskIndicators';
import { publicCache } from '../lib/cache';
import { eopSourceFiles } from '../lib/eopSource';
import { seoMeta } from '../lib/meta';

/**
 * Compose the muted sub-line under „Брой оферти". The AOP feed gives us the gross submitted count
 * (`bidsReceived`) plus three siblings — `bidsRejected`, `bidsSme`, `bidsNonEea`. Policy:
 *
 *   - `bidsRejected` — surface whenever populated, including 0. „0 отстранени" is informative as
 *     the explicit „nobody was disqualified" — it tells the reader the rejection field was
 *     reported, not that data is missing.
 *   - `bidsSme`, `bidsNonEea` — surface only when > 0. A bare „0 от МСП" / „0 извън ЕИП" reads as
 *     noise on the majority of contracts where the bidder pool happened not to include those
 *     categories; the headline number already carries the full count.
 *   - NULL on any field — the source never published it for this contract; always hide.
 *
 * Examples (real-data shapes):
 *   - received=25, rejected=24, sme=18, non_eea=NULL → „1 допусната · 24 отстранени · 18 от МСП"
 *   - received=67, rejected=0,  sme=0,  non_eea=NULL → „67 допуснати · 0 отстранени"
 *   - received=8,  rejected=2,  sme=0,  non_eea=NULL → „6 допуснати · 2 отстранени"
 *   - received=N,  rejected=NULL, sme=NULL, non_eea=NULL → null (caller falls back to the source note)
 */
function bidsBreakdown(c: ContractDetail, t: TFunction, locale: Locale): string | null {
  if (c.bidsReceived == null) return null;
  const parts: string[] = [];
  if (c.bidsRejected != null) {
    const admitted = Math.max(0, c.bidsReceived - c.bidsRejected);
    parts.push(
      `${count(admitted, locale)} ${plural(admitted, t('contract.bidsAdmitted_one'), t('contract.bidsAdmitted_many'), locale)}`,
    );
    parts.push(
      `${count(c.bidsRejected, locale)} ${plural(c.bidsRejected, t('contract.bidsRejected_one'), t('contract.bidsRejected_many'), locale)}`,
    );
  }
  if (c.bidsSme != null && c.bidsSme > 0)
    parts.push(t('contract.bidsSme', { count: count(c.bidsSme, locale) }));
  if (c.bidsNonEea != null && c.bidsNonEea > 0)
    parts.push(t('contract.bidsNonEea', { count: count(c.bidsNonEea, locale) }));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function meta({ data, params, matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  const c = data?.contract;
  return seoMeta({
    matches,
    path: `/contracts/${params.id}`,
    title: t('contract.metaTitle', { subject: c?.subject ?? t('contract.fallbackSubject') }),
    description: c
      ? t('contract.metaDescription', {
          unp: c.unp,
          authority: c.authority.name,
          bidder: c.bidder.displayName,
        })
      : '',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  if (!params.id?.trim()) throw new Response('Not Found', { status: 404 });
  const locale = getLocale(request);
  const contract = await getContract(
    context.cloudflare.env.DB,
    contractIdFromSlug(params.id),
    locale,
  );
  if (!contract) throw new Response('Not Found', { status: 404 });
  return { contract };
}

export default function Contract({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  const locale = useLocale();
  const unverifiedValueLabel = t('contract.unverifiedValueLabel');
  const c = loaderData.contract;
  const v = c.value;
  const crumbId = c.unp || c.contractNumber || c.id;
  // Direct links to the day's raw ЦАИС ЕОП open-data files (storage.eop.bg) this record was
  // published in — empty when there's no usable publication date.
  const sourceFiles = eopSourceFiles(c.publishedAt);
  // Procurement subjects range from a few words to 200+ chars. Step the editorial h1 down by length
  // so long titles don't tower; the longest tier (`t-sm`) also line-clamps. Nothing is lost — the
  // full subject is always shown below in „Подробности → Предмет".
  const titleClass = c.subject.length > 140 ? 't-sm' : c.subject.length > 70 ? 't-md' : undefined;
  const betweenParties = `/contracts?authority=${c.authority.slug}&bidder=${c.bidder.slug}`;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('contract.breadcrumbHome'), to: '/' },
          { label: t('contract.breadcrumbContracts'), to: '/contracts' },
          { label: crumbId },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              {t('contract.unp', { unp: c.unp })}
              {c.contractNumber && (
                <> · {t('contract.contractNumber', { number: c.contractNumber })}</>
              )}
              {c.lotLabel && <> · {t('contract.lot', { label: c.lotLabel })}</>}
            </>
          }
          title={c.subject}
          titleClassName={titleClass}
          lede={
            <>
              {c.signedAt
                ? t('contract.ledeSignedBetween', { date: longDate(c.signedAt, locale) })
                : t('contract.ledeBetween')}{' '}
              <Link to={`/authorities/${c.authority.slug}`}>{c.authority.name}</Link>{' '}
              {t('contract.ledeAnd')}{' '}
              <Link to={`/companies/${c.bidder.slug}`}>{c.bidder.displayName}</Link>.
            </>
          }
        >
          {c.eopTenderId && (
            // Deep-link to the procedure's page on the public ЦАИС ЕОП portal, where the official
            // documents are published and downloadable. The portal keys this page on the numeric EOP
            // tenderId (preserved on the parent tender as `eop_tender_id`), NOT the noticeId/document
            // number. The portal is a client-rendered SPA, so this is a clickable deep link, not a
            // scrapeable file list.
            <a
              className="source-cta"
              href={`https://app.eop.bg/today/${c.eopTenderId}`}
              target="_blank"
              rel="noopener"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden="true"
              >
                <path d="M3.5 1.75H9l3.5 3.5v9h-9z" />
                <path d="M9 1.75V5.25h3.5" />
              </svg>
              {t('contract.viewDocsEop')}
              <span className="cta-ext" aria-hidden="true">
                ↗
              </span>
            </a>
          )}
        </PageHeader>

        <Section id="values" title={t('contract.valuesTitle')} hint={t('contract.valuesHint')}>
          <div className="value-history">
            <div className="vh">
              <div className="step">
                {t('contract.valueEstimated')} {c.lots ? t('contract.valueEstimatedLot') : ''}
              </div>
              <strong className="num">
                {v.estimatedEur != null ? money(v.estimatedEur, locale) : '—'}
              </strong>
              {c.lots?.numLots && v.procedureEstimatedEur != null ? (
                <div className="sub">
                  {t('contract.valueWholeProcedure', {
                    value: money(v.procedureEstimatedEur, locale),
                  })}
                </div>
              ) : null}
            </div>
            <div className="vh">
              <div className="step">{t('contract.valueAtSigning')}</div>
              <strong className="num">
                {v.signingEur != null ? money(v.signingEur, locale) : '—'}
              </strong>
              {v.suspect && <div className="sub suspect">{unverifiedValueLabel}</div>}
            </div>
            <div className="vh now">
              <div className="step">{t('contract.valueCurrent')}</div>
              <strong className="num">
                {v.currentEur != null ? money(v.currentEur, locale) : '—'}
              </strong>
              {v.suspect && <div className="sub suspect">{unverifiedValueLabel}</div>}
              {v.deltaPct != null && (
                <div className="delta">
                  {t('contract.valueDelta', { pct: signedPct(v.deltaPct, 1, locale) })}
                </div>
              )}
            </div>
          </div>
          {v.suspect && (
            <p className="small muted">
              {t('contract.valueSuspectNote')}{' '}
              <Link to="/methodology">{t('contract.methodologyLink')}</Link>.
            </p>
          )}
          {c.frameworkAwards != null && (
            <p className="small muted">
              {t('contract.frameworkNote', { count: count(c.frameworkAwards, locale) })}
            </p>
          )}
        </Section>

        <Section id="who" title={t('contract.whoTitle')}>
          <div className="two-col">
            <div>
              <h3>{t('contract.authorityHeading')}</h3>
              <p className="figure-amount">
                <Link to={`/authorities/${c.authority.slug}`}>{c.authority.name}</Link>
              </p>
              <p className="small muted figure-sub">
                {c.authority.typeLabel && <Chip>{c.authority.typeLabel}</Chip>}
                {c.authority.settlement && <> {c.authority.settlement}</>}
              </p>
              <ul className="linklist">
                <li>
                  <Link to={`/contracts?authority=${c.authority.slug}`}>
                    {t('contract.allAuthorityContracts', {
                      count: count(c.authority.totalContracts, locale),
                      word: plural(
                        c.authority.totalContracts,
                        t('contract.contracts_one'),
                        t('contract.contracts_many'),
                        locale,
                      ),
                      value: money(c.authority.totalEur, locale),
                    })}
                  </Link>
                </li>
                <li>
                  <Link to={betweenParties}>{t('contract.betweenPartiesFromAuthority')}</Link>
                </li>
              </ul>
            </div>
            <div>
              <h3>{t('contract.bidderHeading')}</h3>
              <p className="figure-amount">
                <Link to={`/companies/${c.bidder.slug}`}>{c.bidder.displayName}</Link>
              </p>
              <p className="small muted figure-sub">
                {c.bidder.eik ? (
                  <>
                    {t('contract.eik')} <span className="mono">{c.bidder.eik}</span>
                    <ExternalEikLink eik={c.bidder.eik} />
                  </>
                ) : (
                  t('contract.unverifiedEik')
                )}
                {c.bidder.settlement && <> · {c.bidder.settlement}</>}
                {c.bidder.kind === 'consortium' && (
                  <>
                    {' '}
                    · <Chip>{t('contract.chipConsortium')}</Chip>
                  </>
                )}
                {c.bidder.sector && (
                  <>
                    {' '}
                    · <Chip>{c.bidder.sector.short}</Chip>
                  </>
                )}
              </p>
              <ul className="linklist">
                <li>
                  <Link to={`/contracts?bidder=${c.bidder.slug}`}>
                    {t('contract.allBidderContracts', {
                      count: count(c.bidder.totalContracts, locale),
                      word: plural(
                        c.bidder.totalContracts,
                        t('contract.contracts_one'),
                        t('contract.contracts_many'),
                        locale,
                      ),
                      value: money(c.bidder.totalEur, locale),
                    })}
                  </Link>
                </li>
                <li>
                  <Link to={betweenParties}>{t('contract.betweenPartiesFromBidder')}</Link>
                </li>
              </ul>
              {c.subcontractor && (
                <p className="small muted figure-note">
                  {t('contract.subcontractor')} <strong>{c.subcontractor.name}</strong>
                  {c.subcontractor.eik && (
                    <>
                      {' '}
                      · {t('contract.eik')} <span className="mono">{c.subcontractor.eik}</span>
                      {/^\d{9}(\d{4})?$/.test(c.subcontractor.eik) && (
                        <ExternalEikLink eik={c.subcontractor.eik} />
                      )}
                    </>
                  )}
                  {c.subcontractor.valueEur != null && (
                    <> · {money(c.subcontractor.valueEur, locale)}</>
                  )}
                </p>
              )}
            </div>
          </div>
        </Section>

        <RiskIndicators contract={c} />

        <Section id="facts" title={t('contract.factsTitle')}>
          <FactsList
            rows={[
              c.contractNumber && {
                term: t('contract.factContractNumber'),
                value: c.contractNumber,
                sub: c.documentNumber
                  ? t('contract.factDocumentNumber', { number: c.documentNumber })
                  : undefined,
              },
              { term: t('contract.factUnp'), value: <span className="mono">{c.unp}</span> },
              c.lotLabel && { term: t('contract.factLot'), value: c.lotLabel },
              { term: t('contract.factSubject'), value: c.subject },
              c.contractKind && { term: t('contract.factObject'), value: c.contractKind },
              c.cpvCode && {
                term: t('contract.factCpv'),
                value: (
                  <>
                    <span className="mono">{c.cpvCode}</span>
                    {c.cpvDescription ? ` ${c.cpvDescription}` : ''}
                  </>
                ),
                sub: t('contract.factCpvSub'),
              },
              c.sector && { term: t('contract.factSector'), value: c.sector.short },
              { term: t('contract.factProcedure'), value: c.procedureLabel },
              {
                term: t('contract.factBids'),
                value:
                  c.bidsReceived != null ? (
                    count(c.bidsReceived, locale)
                  ) : (
                    <span className="muted">{t('contract.factBidsNotProvided')}</span>
                  ),
                // Break the gross count down by status/category — surfaces what „Брой оферти" actually
                // means (it's the gross submitted count, including rejections — see docs/etl-pipeline.md
                // and the staging columns at packages/db/migrations/0000_init.sql:363-365). Each clause
                // only appears when the source published a non-zero value, so contracts without any
                // rejection/SME data fall back to the original „самите оферти…" footnote.
                sub: bidsBreakdown(c, t, locale) ?? t('contract.factBidsFallback'),
              },
              {
                term: t('contract.factEuFunding'),
                value:
                  c.euFunded == null ? (
                    <span className="muted">{t('contract.factNoData')}</span>
                  ) : c.euFunded ? (
                    <Flag variant="soft">{t('contract.euYes')}</Flag>
                  ) : (
                    <Flag variant="soft">{t('contract.euNo')}</Flag>
                  ),
                sub: c.euProgramme ?? undefined,
              },
            ]}
          />
        </Section>

        <Section id="dates" title={t('contract.datesTitle')}>
          <FactsList
            rows={[
              {
                term: t('contract.factSignedAt'),
                value: c.signedAt ? (
                  <>
                    {longDate(c.signedAt, locale)}{' '}
                    {c.dateSuspect && <span className="suspect">{t('contract.dateSuspect')}</span>}
                  </>
                ) : (
                  <span className="muted">{t('contract.factMissing')}</span>
                ),
              },
              {
                term: t('contract.factPublishedAt'),
                value: c.publishedAt ? (
                  longDate(c.publishedAt, locale)
                ) : (
                  <span className="muted">{t('contract.factMissing')}</span>
                ),
              },
              {
                term: t('contract.factDuration'),
                value:
                  c.durationDays != null ? (
                    t('contract.durationDays', { count: count(c.durationDays, locale) })
                  ) : (
                    <span className="muted">{t('contract.factDurationMissing')}</span>
                  ),
              },
              {
                term: t('contract.factStartDate'),
                value: c.startDate ? (
                  longDate(c.startDate, locale)
                ) : (
                  <span className="muted">{t('contract.factMissing')}</span>
                ),
              },
              {
                term: t('contract.factEndDate'),
                value: c.endDate ? (
                  longDate(c.endDate, locale)
                ) : (
                  <span className="muted">{t('contract.factMissing')}</span>
                ),
              },
            ]}
          />
        </Section>

        {c.lots && c.lots.rows.length > 0 && (
          <Section
            id="lots"
            title={t('contract.lotsTitle')}
            hint={
              <>
                {t('contract.lotsHintPre')} <span className="mono">{c.lots.unp}</span>{' '}
                {t('contract.lotsHintPost')}{' '}
                <Link to="/methodology">{t('contract.lotsHintMethodology')}</Link>).
              </>
            }
          >
            <div className="table-wrap">
              <table className="lot-table">
                <caption className="sr-only">{t('contract.lotsTableCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="col-w-60">
                      {t('contract.colLot')}
                    </th>
                    <th scope="col">{t('contract.colSection')}</th>
                    <th scope="col">{t('contract.colContractor')}</th>
                    <th scope="col" className="num">
                      {t('contract.colEstimated')}
                    </th>
                    <th scope="col" className="num">
                      {t('contract.colAtSigning')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.lots.rows.map((l) => (
                    <tr key={l.lotLabel} className={l.isCurrent ? 'current' : undefined}>
                      <td className="rank">{l.lotLabel}</td>
                      <td>
                        {l.isCurrent ? (
                          <strong>{l.subject}</strong>
                        ) : l.contractId ? (
                          <Link to={`/contracts/${l.contractId}`}>{l.subject}</Link>
                        ) : (
                          l.subject
                        )}
                      </td>
                      <td>
                        {l.contractorSlug ? (
                          l.isCurrent ? (
                            <strong>{l.contractorName}</strong>
                          ) : (
                            <Link to={`/companies/${l.contractorSlug}`}>{l.contractorName}</Link>
                          )
                        ) : (
                          <span className="muted">{t('contract.noSignedContract')}</span>
                        )}
                      </td>
                      <td className="money">
                        {l.estimatedEur != null ? money(l.estimatedEur, locale) : '—'}
                      </td>
                      <td className="money">
                        {l.signingEur != null ? money(l.signingEur, locale) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(c.lots.estimatedTotalEur || c.lots.signedTotalEur) && (
              <p className="small muted mt-8">
                {c.lots.estimatedTotalEur && (
                  <>
                    {t('contract.lotsEstimatedTotalPre')}{' '}
                    <strong>{money(c.lots.estimatedTotalEur, locale)}</strong>.{' '}
                  </>
                )}
                {c.lots.signedTotalEur && (
                  <>
                    {t('contract.lotsSignedTotalPre')}{' '}
                    <strong>{money(c.lots.signedTotalEur, locale)}</strong>{' '}
                    {t('contract.lotsSignedTotalPost')}
                  </>
                )}
              </p>
            )}
          </Section>
        )}

        <Section id="provenance" title={t('contract.provenanceTitle')}>
          <p>{t('contract.provenanceLede')}</p>
          <ul className="linklist">
            <li>
              {/* Plain <a>, not React Router <Link>. The .json endpoint is a resource route
                  (returns application/json, no HTML), so client-side navigation can't render it —
                  React Router would treat the JSON as a route module and crash. target=_blank
                  opens the raw record in a new tab so the visitor doesn't lose the contract page. */}
              <a href={`/contracts/${c.id}.json`} target="_blank" rel="noopener">
                {t('contract.jsonRecord')}
              </a>
              <span className="sub">{t('contract.jsonRecordSub', { id: c.id })}</span>
            </li>
          </ul>

          {sourceFiles.length > 0 && (
            <>
              <p className="small muted figure-sub">
                {t('contract.sourceFilesNote', { date: longDate(c.publishedAt!, locale) })}
              </p>
              <ul className="linklist">
                {sourceFiles.map((f) => (
                  <li key={f.url}>
                    {/* Plain <a> to the public MinIO object — external host, opens in a new tab.
                        download is a hint only (ignored cross-origin), so large files open in-tab. */}
                    <a href={f.url} target="_blank" rel="noopener" download>
                      {f.label} {t('contract.sourceFileSuffix')}
                    </a>
                    <span className="sub">{t('contract.sourceFileSub')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </main>
    </>
  );
}
