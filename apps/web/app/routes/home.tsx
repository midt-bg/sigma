import { Link } from 'react-router';
import { count, money } from '@sigma/shared';
import { getHomeData } from '@sigma/db';
import type { Route } from './+types/home';
import { PageHeader } from '../components/PageHeader';
import { TotalsStrip } from '../components/TotalsStrip';
import { publicCache } from '../lib/cache';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Сигма — Платформа за прозрачни възлагания' },
    {
      name: 'description',
      content:
        'Кой какво купува от държавата и общините и на кого плаща — във всички сектори на обществените поръчки. Без регистрация. Всяко число се проследява до конкретния договор.',
    },
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

export default function Home({ loaderData }: Route.ComponentProps) {
  const { totals, topCompanies, topMinistries, topMunicipalities } = loaderData;
  return (
    <main id="main">
      <PageHeader
        kicker="Обществени поръчки"
        title={
          <>
            Къде отиват <em>парите</em> на държавата?
          </>
        }
        lede="Сигма показва кой какво купува от държавата и общините и на кого плаща — във всички сектори на обществените поръчки. Без регистрация, без интерпретация. Всяко число може да бъде проследено до конкретния договор."
      >
        <form className="hero-search" role="search" action="/search">
          <input
            type="search"
            name="q"
            placeholder="Институция, компания, ЕИК или № на договор…"
            aria-label="Търсене"
          />
          <button type="submit">Намери</button>
        </form>
      </PageHeader>

      <TotalsStrip
        label="Обзор на данните"
        totals={[
          { num: count(totals.contracts), label: 'Договора и обособени позиции' },
          { num: money(totals.valueEur), label: 'Обща стойност на договорите' },
          { num: count(totals.authorities), label: 'Институции възложители' },
          { num: count(totals.bidders), label: 'Компании изпълнители' },
        ]}
      />

      <section className="section" aria-labelledby="find-yours">
        <h2 id="find-yours">
          Намери своята <em>институция</em>
        </h2>
        <p className="section-hint">
          Започни оттук, ако те интересува конкретно министерство, община, агенция или болница.
          Списъкът показва най-големите по обем на поръчките през 2020–2026 г.
        </p>
        <div className="two-col">
          <div>
            <p className="subhead">Министерства, агенции и държавни предприятия</p>
            <div className="muni-grid">
              {topMinistries.map((a) => (
                <Link key={a.slug} to={`/authorities/${a.slug}`}>
                  {a.name} <span className="num">{money(a.spentEur)}</span>
                </Link>
              ))}
            </div>
          </div>
          <div>
            <p className="subhead">Общини</p>
            <div className="muni-grid">
              {topMunicipalities.map((a) => (
                <Link key={a.slug} to={`/authorities/${a.slug}`}>
                  {a.name} <span className="num">{money(a.spentEur)}</span>
                </Link>
              ))}
            </div>
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
          Компании, наредени по обща стойност на спечелените договори, 2020–2026. Обединенията
          (ДЗЗД/консорциуми) се броят като един изпълнител.{' '}
          <Link to="/companies">Виж пълния списък →</Link>
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Компания</th>
                <th scope="col" className="num">
                  Спечелени
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

      <section className="section" aria-labelledby="how">
        <h2 id="how">
          Как се чете <em>тази платформа</em>
        </h2>
        <div className="two-col">
          <div>
            <h3 style={{ marginBottom: 8 }}>Какво показва Сигма</h3>
            <p>
              Сигма обединява публични данни от регистъра на обществените поръчки (АОП / ЦАИС ЕОП) —
              кой възлага, на кого, какво и за колко. Всяко число тук се разлага до конкретните
              договори, които го съставят.
            </p>
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Атомен запис: договорът</h3>
            <p>
              Всеки агрегат на тази платформа — сума за институция, сума за компания, поток между
              двете — се разлага до конкретните възложени договори. „Брой оферти" се показва само
              като броя; самите оферти не са в публичните данни.{' '}
              <Link to="/methodology">Виж методологията →</Link>
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
