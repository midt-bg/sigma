import { Link } from 'react-router';
import { count, money, pct, periodRange, plural } from '@sigma/shared';
import { bidderIdFromSlug, getCompany } from '@sigma/db';
import type { Route } from './+types/company';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { StackedBar } from '../components/StackedBar';
import { ContractMiniTable } from '../components/ContractMiniTable';
import { ShareBar, Chip, Section, SourceLine } from '../components/ui';
import { publicCache } from '../lib/cache';

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

export function meta({ data }: Route.MetaArgs) {
  const name = data?.company.displayName ?? 'Компания';
  const meta = [
    { title: `${name} — Сигма` },
    { name: 'description', content: `Профил на ${name} в обществените поръчки 2020–2026.` },
  ];
  if (data?.company && isSingleNaturalPersonProfile(data.company.kind, data.company.legalForm)) {
    meta.push({ name: 'robots', content: 'noindex' });
  }
  return meta;
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!params.eik?.trim()) throw new Response('Not Found', { status: 404 });
  const id = bidderIdFromSlug(params.eik);
  if (!id) throw new Response('Not Found', { status: 404 });
  const company = await getCompany(context.cloudflare.env.DB, id);
  if (!company) throw new Response('Not Found', { status: 404 });
  return { company };
}

export default function Company({ loaderData }: Route.ComponentProps) {
  const c = loaderData.company;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Компании', to: '/companies' },
          { label: c.displayName },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              {c.kind === 'consortium' ? 'Обединение' : 'Компания'}
              {c.sector && (
                <>
                  {' '}
                  · <Chip>{c.sector.short}</Chip>
                </>
              )}
              {c.eik ? <> · ЕИК&nbsp;{c.eik}</> : <> · непотвърден ЕИК</>}
            </>
          }
          title={c.displayName}
          lede={`Профил, обобщаващ публичните средства, спечелени от ${c.kind === 'consortium' ? 'това обединение' : 'тази компания'} през регистъра на обществените поръчки за периода 2020–2026 г.`}
        />

        <FactsList
          label="Ключови показатели"
          rows={[
            { term: 'Общо спечелено', value: money(c.wonEur) },
            c.sector && {
              term: 'Основен сектор',
              value: `${c.sector.label} (CPV ${c.sector.code})`,
              sub: c.sectorSharePct != null ? `${pct(c.sectorSharePct)} от стойността` : undefined,
            },
            { term: 'Брой договори', value: count(c.contracts) },
            { term: 'Брой институции платци', value: count(c.authorities) },
            { term: 'Период', value: periodRange(c.periodFirst, c.periodLast) },
            { term: 'Дял ЕС финансиране', value: pct(c.euSharePct) },
            c.avgBids != null && {
              term: 'Среден брой оферти на търг',
              value: c.avgBids.toString().replace('.', ','),
            },
            {
              term: 'Вид субект',
              value: c.kind === 'consortium' ? 'обединение' : 'дружество',
              sub: c.kind === 'consortium' ? '(ДЗЗД / консорциум)' : undefined,
            },
            c.settlement && { term: 'Седалище', value: c.settlement, sub: c.region ?? undefined },
            c.suspect > 0 && {
              term: 'Непотвърдена стойност',
              value: `${count(c.suspect)} ${plural(c.suspect, 'договор', 'договора')}`,
              sub: 'изключени от сумите — данните се преглеждат',
            },
          ]}
        />

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
                ? `Участници в обединението (${count(c.participants.length)})`
                : 'Описание на обединението'
            }
            hint={
              c.participants.length > 0
                ? 'Имена от описанието на договора в АОП. Сумите се водят на ниво обединение — индивидуални профили на участниците ще се появят след свързване с Търговския регистър.'
                : 'Източникът съдържа свободен текст вместо структуриран списък участници. Запазваме описанието както е в обявата.'
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
              <blockquote
                style={{
                  margin: 0,
                  padding: 'var(--s-3) var(--s-4)',
                  borderLeft: '3px solid var(--rule)',
                  color: 'var(--ink-soft)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {c.membershipNote}
              </blockquote>
            )}
          </Section>
        )}

        <Section
          id="from"
          title="Откъде печели"
          hint={`Институции, наредени по сума, заплатена на ${c.displayName.replace(/\.$/, '')}.`}
        >
          <div className="table-wrap tbl-cards">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Институция</th>
                  <th scope="col" className="num">
                    Платено на компанията
                  </th>
                  <th scope="col" className="num">
                    Договори
                  </th>
                  <th scope="col">Дял от спечеленото</th>
                </tr>
              </thead>
              <tbody>
                {c.topAuthorities.map((a, i) => (
                  <tr key={a.slug}>
                    <td className="rank cell-rank" data-label="#">
                      {i + 1}
                    </td>
                    <td className="cell-title" data-label="Институция">
                      <Link to={`/authorities/${a.slug}`}>{a.name}</Link>
                    </td>
                    <td className="money" data-label="Платено">
                      {money(a.paidEur)}
                    </td>
                    <td className="money" data-label="Договори">
                      {count(a.contracts)}
                    </td>
                    <td data-label="Дял">
                      <ShareBar ratio={a.sharePct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.moreAuthorities > 0 && (
            <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
              <Link to={`/contracts?bidder=${c.slug}`}>
                … още {count(c.moreAuthorities)} институции — виж всички договори →
              </Link>
            </p>
          )}
        </Section>

        <div className="two-col">
          <Section
            id="how-win"
            title="Как печели"
            hint="Тип на процедурата, с която компанията е спечелила договорите."
          >
            <StackedBar slices={c.procedureMix.filter((s) => s.sharePct >= 0.0005)} />
          </Section>

          <Section
            id="bids"
            title="Брой оферти на спечелените търгове"
            hint="Колко оферти е имало на търговете, които компанията е спечелила (където данните го посочват)."
          >
            <table>
              <tbody>
                <tr>
                  <td>1 оферта</td>
                  <td className="money">{count(c.bids.one)} търга</td>
                </tr>
                <tr>
                  <td>2 оферти</td>
                  <td className="money">{count(c.bids.two)} търга</td>
                </tr>
                <tr>
                  <td>3 оферти</td>
                  <td className="money">{count(c.bids.three)} търга</td>
                </tr>
                <tr>
                  <td>4 и повече оферти</td>
                  <td className="money">{count(c.bids.fourPlus)} търга</td>
                </tr>
                {c.bids.unknown > 0 && (
                  <tr>
                    <td className="muted">няма данни</td>
                    <td className="money muted">{count(c.bids.unknown)} търга</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>
        </div>

        <Section
          id="latest"
          title="Най-големи договори"
          hint={
            <>
              {Math.min(c.topContracts.length, 7)} от {count(c.contracts)}{' '}
              {plural(c.contracts, 'договор', 'договора')}, подредени по стойност.{' '}
              <Link to={`/contracts?bidder=${c.slug}`}>
                Виж всички / филтрирай / свали като CSV →
              </Link>
            </>
          }
        >
          <ContractMiniTable items={c.topContracts} counterparty="authority" />
          <SourceLine>
            Източник: АОП / ЦАИС ЕОП. {c.eik ? `ЕИК ${c.eik}.` : 'Изпълнител без потвърден ЕИК.'}
          </SourceLine>
        </Section>
      </main>
    </>
  );
}
