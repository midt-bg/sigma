import { useEffect } from 'react';
import { Link } from 'react-router';
import { count, date, money, moneyBare, pct } from '@sigma/shared';
import { getHomeData, getDb } from '@sigma/db';
import type { ContractListItem } from '@sigma/api-contract';
import type { Route } from './+types/home';
import { Band, BandBody, Corners } from '../components/Band';
import { SmartSearch } from '../components/SmartSearch';
import { RankedBars } from '../components/RankedBars';
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

// Factual indicator tags for a standout contract. ONLY indicators backed by a field the list query
// actually returns are rendered — the design also shows „99,8% от прогнозата" and „анекс +18%",
// which need the signing/estimate ratio and amendment delta the handoff lists as NEW derived
// fields. Those are not in ContractListItem, so they are deliberately omitted rather than
// approximated: an indicator the data cannot support has no place on a transparency surface.
function indicators(c: ContractListItem): { label: string; risk: boolean }[] {
  const out: { label: string; risk: boolean }[] = [];
  if (c.bidsReceived === 1) out.push({ label: '1 оферта', risk: true });
  else if (c.bidsReceived != null && c.bidsReceived > 1)
    out.push({ label: `${c.bidsReceived} оферти`, risk: false });
  if (c.euFunded) out.push({ label: 'ЕС финансиране', risk: false });
  if (c.isConsortium) out.push({ label: 'обединение', risk: false });
  return out;
}

// „Поръчки, които се открояват" — the factual rows under the competition climax. Each row is
// title + meta + indicator tags on the left, sum right-aligned. The 3px red edge marks a flagged
// row, but never alone: a flagged row always carries a red indicator tag too, so the signal does
// not depend on colour (WCAG 1.4.1).
function StandoutRows({ items }: { items: ContractListItem[] }) {
  if (items.length === 0) return <p className="small muted">Няма данни за този изглед.</p>;
  return (
    <ul className="standout">
      {items.map((c) => {
        const tags = indicators(c);
        const flagged = tags.some((t) => t.risk);
        return (
          <li key={c.id} className={flagged ? 'is-flagged' : undefined}>
            <div className="standout-main">
              <Link className="standout-title" to={`/contracts/${c.id}`}>
                {c.subject}
              </Link>
              <p className="standout-meta">
                {c.signedAt ? `Възложена ${date(c.signedAt)} · ` : ''}
                {c.bidderDisplayName}
              </p>
              {tags.length > 0 && (
                <p className="standout-tags">
                  {tags.map((t) => (
                    <span key={t.label} className={`tag ${t.risk ? 'tag-risk' : 'tag-neutral'}`}>
                      {t.label}
                    </span>
                  ))}
                </p>
              )}
            </div>
            <div className="standout-sum num">
              {c.valueEur != null ? `${moneyBare(c.valueEur)} €` : '—'}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { totals, topCompanies, topMinistries, topMunicipalities, recentSingleOffer, singleOffer } =
    loaderData;
  const endYear = coverageEndYear(totals.asOf);
  const range = coverageRange(endYear);

  // Share of total value awarded with a single bidder — the Раздел 03 climax.
  const share = totals.valueEur > 0 ? singleOffer.valueEur / totals.valueEur : 0;
  const competitiveEur = Math.max(0, totals.valueEur - singleOffer.valueEur);

  // The load + scroll timeline is loaded on the client only, after paint, and bails out under
  // prefers-reduced-motion. Everything is visible without it: the module sets the "from" state
  // itself, so a blocked or failed chunk simply means no animation — never a blank page.
  useEffect(() => {
    let cancel: (() => void) | undefined;
    import('../lib/home-motion.client')
      .then((m) => {
        cancel = m.runHomeMotion();
      })
      .catch(() => {
        /* animation is decorative — a failed chunk must not break the page */
      });
    return () => cancel?.();
  }, []);

  return (
    <main id="main" className="dossier">
      <Band no="Раздел 01" title="Обхват на данните" labelledBy="hero-title">
        <BandBody>
          <div className="hero-rule" data-a="rule" aria-hidden="true" />
          <h1 className="hero-title" id="hero-title">
            <span data-a="word">Къде</span> <span data-a="word">отиват</span>{' '}
            <span data-a="word" className="hero-mark-word">
              парите
              <span className="hero-underline" data-a="under" aria-hidden="true" />
            </span>{' '}
            <span data-a="word">на</span> <span data-a="word">държавата?</span>
          </h1>
          <p className="hero-lede" data-a="lede">
            СИГМА показва как държавните институции и общините харчат парите на данъкоплатците чрез
            обществени поръчки във всички сектори. Без регистрация, без тълкуване. Зад всяко число
            стои конкретен договор — можеш да го отвориш.
          </p>
          <div className="blueprint hero-search" data-a="search">
            <Corners />
            <SmartSearch variant="hero" />
          </div>
        </BandBody>
      </Band>

      <div className="figures" data-rows="figs">
        <div className="fig" data-a="fig">
          <div className="fig-cap">Фиг. 1.1</div>
          <div className="fig-value" data-count={totals.contracts}>
            {count(totals.contracts)}
          </div>
          <div className="fig-label">Договори и обособени позиции</div>
        </div>
        <div className="fig" data-a="fig">
          <div className="fig-cap">Фиг. 1.2</div>
          <div className="fig-value" data-count={totals.valueEur} data-money="1">
            {moneyBare(totals.valueEur)}
          </div>
          <div className="fig-label">Обща стойност на договорите (€)</div>
        </div>
        <div className="fig" data-a="fig">
          <div className="fig-cap">Фиг. 1.3</div>
          <div className="fig-value" data-count={totals.authorities}>
            {count(totals.authorities)}
          </div>
          <div className="fig-label">Институции възложители</div>
        </div>
        <div className="fig" data-a="fig">
          <div className="fig-cap">Фиг. 1.4</div>
          <div className="fig-value" data-count={totals.bidders}>
            {count(totals.bidders)}
          </div>
          <div className="fig-label">Компании изпълнители</div>
        </div>
      </div>
      <p className="coverage-note">
        Обхват: {coveragePartialNote(endYear)}
        {totals.asOf ? `, последен договор ${date(totals.asOf)}` : ''}.
      </p>

      <Band no="Раздел 02" title="Възложители" split labelledBy="find-yours">
        <BandBody>
          <h2 id="find-yours" className="band-h2">
            Министерства, агенции и държавни предприятия
          </h2>
          <p className="band-hint">По обем на поръчките, {range} г.</p>
          <RankedBars items={topMinistries} />
        </BandBody>
        <BandBody>
          <h2 className="band-h2">Общини</h2>
          <p className="band-hint">По обем на поръчките, {range} г.</p>
          <RankedBars items={topMunicipalities} />
          <p className="small muted mt-8">
            <Link to="/authorities">Виж пълния списък на институциите →</Link>
          </p>
        </BandBody>
      </Band>

      <Band no="Раздел 03" title="Конкуренция" risk labelledBy="single-offer">
        <BandBody>
          <h2 id="single-offer" className="sr-only">
            Поръчки с една оферта
          </h2>
          <div className="climax">
            <div className="climax-figure">
              <div className="climax-pct" data-a="riskpct" data-count={share * 100} data-dec="1">
                {pct(share)}
              </div>
              <p className="climax-note">
                от стойността на всички поръчки е възложена при един-единствен участник
              </p>
            </div>
            <div className="climax-body">
              <div className="share-bar" data-a="share">
                <span
                  className="share-fill"
                  style={{ width: `${(share * 100).toFixed(1)}%` }}
                  aria-hidden="true"
                />
              </div>
              <p className="share-legend">
                <span>Една оферта · {money(singleOffer.valueEur)}</span>
                <span>Конкурентни · {money(competitiveEur)}</span>
              </p>
              <p className="climax-lede">
                Една оферта означава липса на ценова конкуренция. СИГМА не тълкува — показва фактите
                за всяка поръчка и връзката ѝ с конкретния договор. Изводите остават за читателя.
              </p>
            </div>
          </div>

          <h3 className="band-h3">Поръчки, които се открояват</h3>
          <p className="band-hint">
            Фактите по всяка поръчка, без оценка. Всеки ред води до първичния договор.
          </p>
          <StandoutRows items={recentSingleOffer} />
          <p className="small mt-8">
            <Link to="/contracts?bids=1&amp;sort=date-desc">Всички поръчки с една оферта →</Link>
            {' · '}
            <Link to="/methodology">Методология на индикаторите →</Link>
          </p>
        </BandBody>
      </Band>

      <Band no="Раздел 04" title="Изпълнители" labelledBy="top-bene">
        <BandBody>
          <h2 id="top-bene" className="band-h2">
            Топ 10 печеливши компании
          </h2>
          <p className="band-hint">
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
        </BandBody>
      </Band>

      <Band no="Раздел 05" title="Анализи" labelledBy="analytics">
        <BandBody>
          <h2 id="analytics" className="band-h2">
            <Link to="/analytics">Анализи</Link>
          </h2>
          <p className="band-hint">
            Избери гледна точка към същите договори: движение на пари, място, време или конкуренция.
          </p>
          <div className="lenses" data-rows="lenses">
            {ANALYTICS_LENSES.map((item) => (
              <Link className="blueprint lens" to={item.href} key={item.href}>
                <Corners />
                <span className="lens-kicker">{item.title}</span>
                <span className="lens-desc">{item.desc}</span>
              </Link>
            ))}
          </div>
        </BandBody>
      </Band>

      <Band no="Раздел 06" title="Как да четем данните" split labelledBy="how">
        <BandBody>
          <h2 id="how" className="band-h2">
            Какво показва СИГМА
          </h2>
          <p>
            СИГМА — Система за Интегриран Граждански Мониторинг и Анализ — обединява публични данни
            от Регистъра на обществените поръчки (АОП / ЦАИС ЕОП): кой какво възлага, на кого и за
            колко. Зад всяко число тук стоят конкретните договори, които го формират.
          </p>
        </BandBody>
        <BandBody>
          <h2 className="band-h2">Основната единица: договорът</h2>
          <p>
            Всяко обобщение тук — обща сума за институция, за компания или поток между двете — се
            свежда до конкретните възложени договори. „Брой оферти“ показваме само като число;
            самите оферти ги няма в публичните данни.{' '}
            <Link to="/methodology">Виж методологията →</Link>
          </p>
        </BandBody>
      </Band>
    </main>
  );
}
