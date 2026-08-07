import { Link } from 'react-router';
import { count, date, moneyBare } from '@sigma/shared';
import { getHomeData, getDb } from '@sigma/db';
import type { ContractListItem } from '@sigma/api-contract';
import type { Route } from './+types/home';
import type { RiskFlagType } from '../lib/riskLogic';
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

const metaTitle = 'СИГМА — Платформа за прозрачност на обществените поръчки';
const metaDescription =
  'СИГМА показва как държавните институции и общините харчат парите на данъкоплатците чрез обществени поръчки във всички сектори. Без регистрация. Зад всяко число стои конкретен договор.';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({ matches, path: '/', title: metaTitle, description: metaDescription });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  // Identical for every visitor between refreshes — the `Cache-Control` above (publicCache(3600))
  // memoises this response at the edge; no separate data cache.
  return getHomeData(getDb(env));
}

function SingleOfferTable({
  items,
  allHref,
  caption = 'Поръчки с една оферта',
}: {
  items: ContractListItem[];
  allHref: string;
  caption?: string;
}) {
  if (items.length === 0) return <p className="small muted">Няма данни за този изглед.</p>;
  return (
    <>
      <div className="table-wrap tbl-cards">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Дата</th>
              <th scope="col">Договор</th>
              <th scope="col">Възложител · Изпълнител</th>
              <th scope="col" className="num">
                Стойност (€)
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="nowrap" data-label="Дата">
                  {date(c.signedAt)}
                </td>
                <td className="cell-title" data-label="Договор">
                  <Link to={`/contracts/${c.id}`}>{c.subject}</Link>
                </td>
                <td data-label="Възложител · Изпълнител">
                  <Link to={`/authorities/${c.authoritySlug}`}>{c.authorityName}</Link>
                  {' · '}
                  <Link to={`/companies/${c.bidderSlug}`}>{c.bidderDisplayName}</Link>
                </td>
                <td className="money" data-label="Стойност (€)">
                  {c.valueEur != null ? moneyBare(c.valueEur) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted mt-8">
        <Link to={allHref}>Виж всички →</Link>
      </p>
    </>
  );
}

// Bulgarian labels for the risk-signal types. `satisfies Record<RiskFlagType, string>` makes TypeScript
// enforce that every signal type has a label (and none is misspelled) — a renamed/added RiskFlagType now
// fails the build here instead of silently falling through to the raw key at runtime (#236 review).
const FLAG_LABELS = {
  no_competition: 'Липса на конкуренция',
  eu_no_competition: 'Липса на конкуренция (със средства от ЕС)',
  high_markup: 'Ръст на стойността чрез анекси',
  anomalies: 'Стойностна или времева аномалия',
} satisfies Record<RiskFlagType, string>;

export default function Home({ loaderData }: Route.ComponentProps) {
  const {
    totals,
    flagged,
    topFlagged,
    topCompanies,
    topMinistries,
    topMunicipalities,
    recentSingleOffer,
    topSingleOffer,
    singleOffer,
  } = loaderData;
  const endYear = coverageEndYear(totals.asOf);
  const range = coverageRange(endYear);
  return (
    <main id="main">
      <div className="hero-panel">
        <PageHeader
          kicker="Обществени поръчки"
          title={
            <>
              Къде отиват <em>парите</em> на държавата?
            </>
          }
          lede="СИГМА показва как държавните институции и общините харчат парите на данъкоплатците чрез обществени поръчки във всички сектори. Без регистрация, без тълкуване. Зад всяко число стои конкретен договор — можеш да го отвориш."
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
        label="Накратко"
        totals={[
          { num: count(totals.contracts), label: 'Договори и обособени позиции' },
          { num: moneyBare(totals.valueEur), label: 'Обща стойност на договорите (€)' },
          { num: count(totals.authorities), label: 'Институции възложители' },
          { num: count(totals.bidders), label: 'Компании изпълнители' },
        ]}
      />
      <p className="small muted coverage-note">
        Обхват: {coveragePartialNote(endYear)}
        {totals.asOf ? `, последен договор ${date(totals.asOf)}` : ''}.
      </p>

      <section className="section flagged" aria-labelledby="flagged">
        <h2 id="flagged">
          Договори със <em>сигнали за риск</em>
        </h2>
        <p className="section-hint">
          Обща стойност на договорите, при които СИГМА отбелязва поне един структурен сигнал — липса
          на конкуренция, ръст на стойността чрез анекси или стойностна/времева аномалия. Сигналите
          са ориентири за преглед, не присъда. <Link to="/methodology#flagged">Как ги четем →</Link>
          {' · '}
          <Link to="/methodology#contact">Смятате сигнал за грешен? →</Link>
        </p>

        <SingleOfferPortion
          valueEur={flagged.totalEur}
          totalEur={totals.valueEur}
          scopeLabel="на всички договори"
        />

        <div className="flagged-cols">
          <div>
            <h3 className="flagged-h3">По вид сигнал</h3>
            <ul className="flagged-list">
              {flagged.byType
                .filter((r) => r.contracts > 0)
                .map((r) => (
                  <li key={r.type}>
                    <Link to={`/contracts?flag=${r.type}&sort=value-desc`}>
                      <span>{FLAG_LABELS[r.type as RiskFlagType] ?? r.type}</span>
                      <span className="flagged-val">
                        {moneyBare(r.eur)} € · {count(r.contracts)}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
            <p className="small muted flagged-note">
              Един договор може да носи няколко сигнала, затова редовете тук се застъпват и сборът
              им надхвърля общата (де-дублирана) сума.
            </p>
          </div>

          <div>
            <h3 className="flagged-h3">По сектор</h3>
            <ul className="flagged-list">
              {flagged.bySector.map((s) => (
                <li key={s.code}>
                  <Link to={`/contracts?flag=all&sector=${s.code}&sort=value-desc`}>
                    <span>{s.label}</span>
                    <span className="flagged-val">
                      {moneyBare(s.eur)} € · {count(s.contracts)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="flagged-h3">По тип институция</h3>
            <ul className="flagged-list">
              {flagged.byAuthorityType.map((a) => (
                <li key={a.typeGroup}>
                  <Link
                    to={`/contracts?flag=all&type=${encodeURIComponent(a.typeGroup)}&sort=value-desc`}
                  >
                    <span>{a.typeGroup}</span>
                    <span className="flagged-val">
                      {moneyBare(a.eur)} € · {count(a.contracts)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <SingleOfferTable
          items={topFlagged}
          caption="Договори с най-висока стойност със сигнали за риск"
          allHref="/contracts?flag=all&sort=value-desc"
        />
      </section>

      <section className="section" aria-labelledby="find-yours">
        <h2 id="find-yours">
          Най-активните <em>институции</em>
        </h2>
        <p className="section-hint">
          Започни оттук, ако те интересува конкретно министерство, община, агенция или болница.
          Подредени по обема на поръчките за {range} г.
        </p>
        <div className="two-col">
          <div>
            <p className="subhead">Министерства, агенции и държавни предприятия</p>
            <RankedBars items={topMinistries} />
          </div>
          <div>
            <p className="subhead">Общини</p>
            <RankedBars items={topMunicipalities} />
            <p className="small muted mt-8">
              <Link to="/authorities">Виж пълния списък на институциите →</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="top-bene">
        <h2 id="top-bene">
          Топ 10 печеливши <em>компании</em>
        </h2>
        <p className="section-hint">
          Компании, подредени по обща стойност на спечелените договори за {range}. Обединенията
          (ДЗЗД/консорциуми) се броят като един изпълнител.{' '}
          <Link to="/companies">Виж пълния списък →</Link>
        </p>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">
              Топ печеливши компании по стойност на спечелените договори
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Компания</th>
                <th scope="col" className="num">
                  Спечелено (€)
                </th>
                <th scope="col" className="num">
                  Договори
                </th>
                <th scope="col" className="num">
                  Институции
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
                        <span className="flag soft">обединение</span>
                      ) : (
                        <>
                          {c.eik ? `ЕИК ${c.eik}` : 'непотвърден ЕИК'}
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
                  <td className="money">{moneyBare(c.wonEur)}</td>
                  <td className="money">{count(c.contracts)}</td>
                  <td className="money">{count(c.authorities)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="single-offer">
        <h2 id="single-offer">
          Поръчки с <em>една оферта</em>
        </h2>
        <p className="section-hint">
          Една оферта означава липса на ценова конкуренция. Ето поръчките с един участник —
          подредени по време или по стойност.
        </p>
        <SingleOfferPortion
          valueEur={singleOffer.valueEur}
          totalEur={totals.valueEur}
          scopeLabel="на всички поръчки"
        />
        <div
          className="tabset"
          role="radiogroup"
          aria-label="Подреждане на поръчките с една оферта"
        >
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
              Скорошни
            </label>
            <label id="tab-so-top" htmlFor="so-top">
              Най-големи по стойност
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
          <Link to="/analytics">Анализи</Link>
        </h2>
        <p className="section-hint">
          Избери гледна точка към същите договори: движение на пари, място, време или конкуренция.
        </p>
        <div className="tiles">
          {ANALYTICS_LENSES.map((item) => (
            <article className="tile" key={item.href}>
              <p className="kicker info">Анализ</p>
              <h3>
                <Link to={item.href}>{item.title}</Link>
              </h3>
              <p className="desc">{item.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="how">
        <h2 id="how">
          Как да четем <em>данните</em>
        </h2>
        <div className="two-col">
          <div>
            <h3 className="mb-8">Какво показва СИГМА</h3>
            <p>
              СИГМА — Система за Интегриран Граждански Мониторинг и Анализ — обединява публични
              данни от Регистъра на обществените поръчки (АОП / ЦАИС ЕОП): кой какво възлага, на
              кого и за колко. Зад всяко число тук стоят конкретните договори, които го формират.
            </p>
          </div>
          <div>
            <h3 className="mb-8">Основната единица: договорът</h3>
            <p>
              Всяко обобщение тук — обща сума за институция, за компания или поток между двете — се
              свежда до конкретните възложени договори. „Брой оферти" показваме само като число;
              самите оферти ги няма в публичните данни.{' '}
              <Link to="/methodology">Виж методологията →</Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
