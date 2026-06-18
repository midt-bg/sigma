import { Link } from 'react-router';
import { count, date, money, pct } from '@sigma/shared';
import { getHomeData } from '@sigma/db';
import type { ContractListItem } from '@sigma/api-contract';
import type { Route } from './+types/home';
import { PageHeader } from '../components/PageHeader';
import { TotalsStrip } from '../components/TotalsStrip';
import { RankedBars } from '../components/RankedBars';
import { OwnershipChip } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageEndYear, coveragePartialNote, coverageRange } from '../lib/coverage';

const metaTitle = 'СИГМА — Платформа за прозрачност на обществените поръчки';
const metaDescription =
  'СИГМА показва как държавните институции и общините харчат парите на данъкоплатците чрез обществени поръчки във всички сектори. Без регистрация. Зад всяко число стои конкретен договор.';

export function meta({ matches }: Route.MetaArgs) {
  const rootData = matches.find((match) => match?.id === 'root')?.data as { origin: string };
  const origin = rootData.origin;
  return [
    { title: metaTitle },
    { name: 'description', content: metaDescription },
    { property: 'og:title', content: metaTitle },
    { property: 'og:description', content: metaDescription },
    { property: 'og:url', content: `${origin}/` },
    { name: 'twitter:title', content: metaTitle },
    { name: 'twitter:description', content: metaDescription },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  // Identical for every visitor between refreshes — the `Cache-Control` above (publicCache(3600))
  // memoises this response at the edge; no separate data cache.
  return getHomeData(env.DB);
}

function SingleOfferTable({ items, allHref }: { items: ContractListItem[]; allHref: string }) {
  if (items.length === 0) return <p className="small muted">Няма данни за този изглед.</p>;
  return (
    <>
      <div className="table-wrap tbl-cards">
        <table>
          <caption className="sr-only">Поръчки с една оферта</caption>
          <thead>
            <tr>
              <th scope="col">Дата</th>
              <th scope="col">Договор</th>
              <th scope="col">Възложител · Изпълнител</th>
              <th scope="col" className="num">
                Стойност
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
                <td className="money" data-label="Стойност">
                  {c.valueEur != null ? money(c.valueEur) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        <Link to={allHref}>Виж всички →</Link>
      </p>
    </>
  );
}

// Money portion of single-offer contracts vs. the whole corpus. A prominent accent percentage
// leads, over the platform's composition bar (.hbar): the single-offer share is the accent-red
// bucket — the established convention for the non-competitive slice — so it reads as a breakdown of
// the total, not a progress track.
function SingleOfferPortion({ valueEur, totalEur }: { valueEur: number; totalEur: number }) {
  const ratio = Math.min(1, Math.max(0, totalEur > 0 ? valueEur / totalEur : 0));
  return (
    <div className="so-portion">
      <p className="so-portion-head">
        <span className="so-portion-pct">{pct(ratio)}</span> от стойността на всички поръчки са по
        договори с <em>една оферта</em>.
      </p>
      <div className="hbar" aria-hidden="true">
        <span style={{ width: `${(ratio * 100).toFixed(1)}%`, background: 'var(--accent)' }} />
        <span style={{ width: `${((1 - ratio) * 100).toFixed(1)}%`, background: 'var(--ink-soft)' }} />
      </div>
      <p className="small muted so-portion-cap">
        {money(valueEur)} от {money(totalEur)}
      </p>
    </div>
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
          <form
            className="hero-search"
            role="search"
            aria-label="Търсене на началната страница"
            action="/search"
          >
            <input
              type="search"
              name="q"
              placeholder="Институция, компания или договор"
              aria-label="Търсене"
            />
            <button type="submit">Намери</button>
          </form>
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
          { num: money(totals.valueEur), label: 'Обща стойност на договорите' },
          { num: count(totals.authorities), label: 'Институции възложители' },
          { num: count(totals.bidders), label: 'Компании изпълнители' },
        ]}
      />
      <p
        className="small muted"
        style={{ margin: 'var(--s-2) auto 0', maxWidth: 'var(--measure)' }}
      >
        Обхват: {coveragePartialNote(endYear)}
        {totals.asOf ? `, последен договор ${date(totals.asOf)}` : ''}.
      </p>

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
            <p className="small muted" style={{ marginTop: 8 }}>
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
                  Спечелено
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
                  <td className="money">{money(c.wonEur)}</td>
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
        <SingleOfferPortion valueEur={singleOffer.valueEur} totalEur={totals.valueEur} />
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

      <section className="section" aria-labelledby="how">
        <h2 id="how">
          Как да четем <em>данните</em>
        </h2>
        <div className="two-col">
          <div>
            <h3 style={{ marginBottom: 8 }}>Какво показва СИГМА</h3>
            <p>
              СИГМА — Система за Интегриран Граждански Мониторинг и Анализ — обединява публични
              данни от Регистъра на обществените поръчки (АОП / ЦАИС ЕОП): кой какво възлага, на
              кого и за колко. Зад всяко число тук стоят конкретните договори, които го формират.
            </p>
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Основната единица: договорът</h3>
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
