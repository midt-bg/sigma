import { Link } from 'react-router';
import { count, longDate, money, moneyBare, plural, signedPct } from '@sigma/shared';
import { contractIdFromSlug, getContract } from '@sigma/db';
import type { ContractDetail } from '@sigma/api-contract';
import type { Route } from './+types/contract';
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
function bidsBreakdown(c: ContractDetail): string | null {
  if (c.bidsReceived == null) return null;
  const parts: string[] = [];
  if (c.bidsRejected != null) {
    const admitted = Math.max(0, c.bidsReceived - c.bidsRejected);
    parts.push(`${count(admitted)} ${plural(admitted, 'допусната', 'допуснати')}`);
    parts.push(`${count(c.bidsRejected)} ${plural(c.bidsRejected, 'отстранена', 'отстранени')}`);
  }
  if (c.bidsSme != null && c.bidsSme > 0) parts.push(`${count(c.bidsSme)} от МСП`);
  if (c.bidsNonEea != null && c.bidsNonEea > 0) parts.push(`${count(c.bidsNonEea)} извън ЕИП`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function meta({ data, params, matches }: Route.MetaArgs) {
  const c = data?.contract;
  return seoMeta({
    matches,
    path: `/contracts/${params.id}`,
    title: `${c?.subject ?? 'Договор'} — СИГМА`,
    description: c
      ? `Договор по УНП ${c.unp} между ${c.authority.name} и ${c.bidder.displayName}.`
      : '',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.id?.trim()) throw new Response('Not Found', { status: 404 });
  const contract = await getContract(context.cloudflare.env.DB, contractIdFromSlug(params.id));
  if (!contract) throw new Response('Not Found', { status: 404 });
  return { contract };
}

const UNVERIFIED_VALUE_LABEL = 'стойност с непотвърдена достоверност';

export default function Contract({ loaderData }: Route.ComponentProps) {
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
          { label: 'Начало', to: '/' },
          { label: 'Договори', to: '/contracts' },
          { label: crumbId },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              УНП {c.unp}
              {c.contractNumber && <> · Договор № {c.contractNumber}</>}
              {c.lotLabel && <> · обособена позиция {c.lotLabel}</>}
            </>
          }
          title={c.subject}
          titleClassName={titleClass}
          lede={
            <>
              {c.signedAt ? `Сключен на ${longDate(c.signedAt)} ` : ''}между{' '}
              <Link to={`/authorities/${c.authority.slug}`}>{c.authority.name}</Link> и{' '}
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
              Виж документите в ЦАИС ЕОП
              <span className="cta-ext" aria-hidden="true">
                ↗
              </span>
            </a>
          )}
        </PageHeader>

        <Section
          id="values"
          title="Стойности във времето"
          hint='Договорът минава през няколко стойности: прогнозна (на възложителя), цена при подписване и текуща. Всички в евро. „Стойност" в списъците по подразбиране е текущата (изчистена) стойност.'
        >
          <div className="value-history">
            <div className="vh">
              <div className="step">Прогнозна {c.lots ? '(позицията)' : ''}</div>
              <strong className="num">
                {v.estimatedEur != null ? money(v.estimatedEur) : '—'}
              </strong>
              {c.lots?.numLots && v.procedureEstimatedEur != null ? (
                <div className="sub">цялата преписка: {money(v.procedureEstimatedEur)}</div>
              ) : null}
            </div>
            <div className="vh">
              <div className="step">При сключване</div>
              <strong className="num">{v.signingEur != null ? money(v.signingEur) : '—'}</strong>
              {v.suspect && <div className="sub suspect">{UNVERIFIED_VALUE_LABEL}</div>}
            </div>
            <div className="vh now">
              <div className="step">Текуща стойност</div>
              <strong className="num">{v.currentEur != null ? money(v.currentEur) : '—'}</strong>
              {v.suspect && <div className="sub suspect">{UNVERIFIED_VALUE_LABEL}</div>}
              {v.deltaPct != null && (
                <div className="delta">{signedPct(v.deltaPct)} спрямо сключване</div>
              )}
            </div>
          </div>
          {v.suspect && (
            <p className="small muted">
              Показана е публикуваната стойност от източника, без СИГМА да я коригира. Виж{' '}
              <Link to="/methodology">методология</Link>.
            </p>
          )}
          {c.frameworkAwards != null && (
            <p className="small muted">
              Рамково споразумение / ДСП — едно от {count(c.frameworkAwards)} възлагания по тази
              процедура. Прогнозната стойност е за цялата процедура, а не за отделното възлагане.
            </p>
          )}
        </Section>

        <Section id="who" title="Възложител и изпълнител">
          <div className="two-col">
            <div>
              <h3>Възложител</h3>
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
                    → Всички {count(c.authority.totalContracts)}{' '}
                    {plural(c.authority.totalContracts, 'договор', 'договора')} на институцията (
                    {money(c.authority.totalEur)})
                  </Link>
                </li>
                <li>
                  <Link to={betweenParties}>
                    → Договори между тази институция и този изпълнител
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3>Изпълнител</h3>
              <p className="figure-amount">
                <Link to={`/companies/${c.bidder.slug}`}>{c.bidder.displayName}</Link>
              </p>
              <p className="small muted figure-sub">
                {c.bidder.eik ? (
                  <>
                    ЕИК <span className="mono">{c.bidder.eik}</span>
                    <ExternalEikLink eik={c.bidder.eik} />
                  </>
                ) : (
                  'непотвърден ЕИК'
                )}
                {c.bidder.settlement && <> · {c.bidder.settlement}</>}
                {c.bidder.kind === 'consortium' && (
                  <>
                    {' '}
                    · <Chip>обединение</Chip>
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
                    → Всички {count(c.bidder.totalContracts)}{' '}
                    {plural(c.bidder.totalContracts, 'договор', 'договора')} на изпълнителя (
                    {money(c.bidder.totalEur)})
                  </Link>
                </li>
                <li>
                  <Link to={betweenParties}>
                    → Договори между този изпълнител и тази институция
                  </Link>
                </li>
              </ul>
              {c.subcontractor && (
                <p className="small muted figure-note">
                  Подизпълнител: <strong>{c.subcontractor.name}</strong>
                  {c.subcontractor.eik && (
                    <>
                      {' '}
                      · ЕИК <span className="mono">{c.subcontractor.eik}</span>
                      {/^\d{9}(\d{4})?$/.test(c.subcontractor.eik) && (
                        <ExternalEikLink eik={c.subcontractor.eik} />
                      )}
                    </>
                  )}
                  {c.subcontractor.valueEur != null && <> · {money(c.subcontractor.valueEur)}</>}
                </p>
              )}
            </div>
          </div>
        </Section>

        <RiskIndicators contract={c} />

        <Section id="facts" title="Подробности">
          <FactsList
            rows={[
              c.contractNumber && {
                term: 'Номер на договор',
                value: c.contractNumber,
                sub: c.documentNumber ? `· документ № ${c.documentNumber}` : undefined,
              },
              { term: 'УНП на преписката', value: <span className="mono">{c.unp}</span> },
              c.lotLabel && { term: 'Обособена позиция', value: c.lotLabel },
              { term: 'Предмет', value: c.subject },
              c.contractKind && { term: 'Обект', value: c.contractKind },
              c.cpvCode && {
                term: 'CPV',
                value: (
                  <>
                    <span className="mono">{c.cpvCode}</span>
                    {c.cpvDescription ? ` ${c.cpvDescription}` : ''}
                  </>
                ),
                sub: 'вторичният CPV код не се публикува в източника',
              },
              c.sector && { term: 'Сектор', value: c.sector.short },
              { term: 'Процедура', value: c.procedureLabel },
              {
                term: 'Брой оферти',
                value:
                  c.bidsReceived != null ? (
                    count(c.bidsReceived)
                  ) : (
                    <span className="muted">не е посочен в данните</span>
                  ),
                // Break the gross count down by status/category — surfaces what „Брой оферти" actually
                // means (it's the gross submitted count, including rejections — see docs/etl-pipeline.md
                // and the staging columns at packages/db/migrations/0000_init.sql:363-365). Each clause
                // only appears when the source published a non-zero value, so contracts without any
                // rejection/SME data fall back to the original „самите оферти…" footnote.
                sub: bidsBreakdown(c) ?? 'самите оферти и стойностите им ги няма в АОП',
              },
              {
                term: 'Финансиране от ЕС',
                value:
                  c.euFunded == null ? (
                    <span className="muted">няма данни</span>
                  ) : c.euFunded ? (
                    <Flag variant="soft">да</Flag>
                  ) : (
                    <Flag variant="soft">не</Flag>
                  ),
                sub: c.euProgramme ?? undefined,
              },
            ]}
          />
        </Section>

        <Section id="dates" title="Дати и срокове">
          <FactsList
            rows={[
              {
                term: 'Подписан на',
                value: c.signedAt ? (
                  <>
                    {longDate(c.signedAt)}{' '}
                    {c.dateSuspect && (
                      <span className="suspect">
                        Възможна грешка в датата — договорът е подписан след публикуване на
                        обявлението
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">липсва</span>
                ),
              },
              {
                term: 'Публикуван в регистъра',
                value: c.publishedAt ? (
                  longDate(c.publishedAt)
                ) : (
                  <span className="muted">липсва</span>
                ),
              },
              {
                term: 'Срок за изпълнение',
                value:
                  c.durationDays != null ? (
                    `${count(c.durationDays)} дни`
                  ) : (
                    <span className="muted">липсва за този запис</span>
                  ),
              },
              {
                term: 'Начална дата',
                value: c.startDate ? longDate(c.startDate) : <span className="muted">липсва</span>,
              },
              {
                term: 'Очакван край',
                value: c.endDate ? longDate(c.endDate) : <span className="muted">липсва</span>,
              },
            ]}
          />
        </Section>

        {c.lots && c.lots.rows.length > 0 && (
          <Section
            id="lots"
            title="Обособени позиции по преписката"
            hint={
              <>
                Преписка <span className="mono">{c.lots.unp}</span> е разделена на обособени
                позиции. Връзката договор↔лот е приблизителна — съпоставяме я по идентификатора на
                позицията (вж. <Link to="/methodology">методология</Link>).
              </>
            }
          >
            <div className="table-wrap">
              <table className="lot-table">
                <caption className="sr-only">Обособени позиции по преписката</caption>
                <thead>
                  <tr>
                    <th scope="col" className="col-w-60">
                      Лот
                    </th>
                    <th scope="col">Участък</th>
                    <th scope="col">Изпълнител</th>
                    <th scope="col" className="num">
                      Прогнозна (€)
                    </th>
                    <th scope="col" className="num">
                      При сключване (€)
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
                          <span className="muted">няма сключен договор</span>
                        )}
                      </td>
                      <td className="money">
                        {l.estimatedEur != null ? moneyBare(l.estimatedEur) : '—'}
                      </td>
                      <td className="money">
                        {l.signingEur != null ? moneyBare(l.signingEur) : '—'}
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
                    Прогнозна стойност на всички лотове:{' '}
                    <strong>{money(c.lots.estimatedTotalEur)}</strong>.{' '}
                  </>
                )}
                {c.lots.signedTotalEur && (
                  <>
                    Сключени договори: <strong>{money(c.lots.signedTotalEur)}</strong> при
                    подписване.
                  </>
                )}
              </p>
            )}
          </Section>
        )}

        <Section id="provenance" title="Произход на данните">
          <p>
            Този запис е сглобен от публикуваните в АОП / ЦАИС ЕОП данни за преписката и
            нормализиран от СИГМА. Имената на институцията и компанията са в стандартизиран вид; ЕИК
            и УНП се запазват буквално.
          </p>
          <ul className="linklist">
            <li>
              {/* Plain <a>, not React Router <Link>. The .json endpoint is a resource route
                  (returns application/json, no HTML), so client-side navigation can't render it —
                  React Router would treat the JSON as a route module and crash. target=_blank
                  opens the raw record in a new tab so the visitor doesn't lose the contract page. */}
              <a href={`/contracts/${c.id}.json`} target="_blank" rel="noopener">
                JSON запис в СИГМА
              </a>
              <span className="sub">машиночетим, всички полета — /contracts/{c.id}.json</span>
            </li>
          </ul>

          {sourceFiles.length > 0 && (
            <>
              <p className="small muted figure-sub">
                Първични данни от ЦАИС ЕОП (отворени данни) за деня на публикуване —{' '}
                {longDate(c.publishedAt!)}. Свалят се директно от storage.eop.bg, без копие в СИГМА;
                всеки файл съдържа пълните данни за деня. Записът за този договор е във файла
                „Договори".
              </p>
              <ul className="linklist">
                {sourceFiles.map((f) => (
                  <li key={f.url}>
                    {/* Plain <a> to the public MinIO object — external host, opens in a new tab.
                        download is a hint only (ignored cross-origin), so large files open in-tab. */}
                    <a href={f.url} target="_blank" rel="noopener" download>
                      {f.label} — storage.eop.bg
                    </a>
                    <span className="sub">пълни данни за деня (JSON)</span>
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
