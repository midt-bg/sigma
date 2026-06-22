import { Form, Link, useNavigation, useSearchParams, useSubmit } from 'react-router';
import { count, money } from '@sigma/shared';
import { CPV_SECTORS } from '@sigma/config';
import { getFlows } from '@sigma/db';
import type { Route } from './+types/flows';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { SankeyDiagram } from '../components/SankeyDiagram';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { coverageRange, getCoverageMeta, yearOptions } from '../lib/coverage';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Потоци на пари — СИГМА' },
    {
      name: 'description',
      content:
        'От институциите възложители към компаниите изпълнители. Дебелината на всеки поток отговаря на стойността на договорите.',
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const sector = sp.get('sector');
  const year = sp.get('year');
  const coverage = await getCoverageMeta(context.cloudflare.env.DB);
  const years = yearOptions(coverage.coverageEndYear);
  // A bogus ?sector (not a CPV division) would filter every flow out and render a blank diagram +
  // empty table silently. Flag it so we show an explicit empty state instead.
  const unknownSector = Boolean(sector) && !CPV_SECTORS.some((s) => s.code === sector);
  const unknownYear = Boolean(year) && !years.includes(year!);
  const data = await getFlows(context.cloudflare.env.DB, {
    sector: unknownSector ? null : sector,
    year: unknownYear ? null : year,
    funding: (sp.get('funding') as 'eu' | 'national' | null) || 'all',
    top: sp.get('top') === '50' ? 50 : 20,
  });
  return { data, coverage, years, unknownSector, unknownYear };
}

export default function Flows({ loaderData }: Route.ComponentProps) {
  const { data, coverage, years, unknownSector, unknownYear } = loaderData;
  const range = coverageRange(coverage.coverageEndYear);
  const [sp] = useSearchParams();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const sel = (k: string) => sp.get(k) ?? '';

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Потоци на пари' }]} />
      <main id="main">
        <PageHeader
          kicker="Визуализация"
          title="Потоци на пари: откъде към кого"
          lede="От институциите възложители (вляво) към компаниите изпълнители (вдясно). Колкото по-дебел е потокът, толкова по-голяма е общата стойност (в евро) на договорите между двете страни."
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label="Настройки на визуализацията"
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            Сектор:
            <select name="sector" defaultValue={unknownSector ? '' : sel('sector')}>
              <option value="">Всички сектори</option>
              {data.sectors.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.short}
                </option>
              ))}
            </select>
          </label>
          <label>
            Година:
            <select name="year" defaultValue={unknownYear ? '' : sel('year')}>
              <option value="">{range}</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label>
            Финансиране:
            <select name="funding" defaultValue={sel('funding')}>
              <option value="">Всички</option>
              <option value="eu">Само с финансиране от ЕС</option>
              <option value="national">Само с национално финансиране</option>
            </select>
          </label>
          <label>
            Топ:
            <select name="top" defaultValue={sel('top') || '20'}>
              <option value="20">Топ 20 потока</option>
              <option value="50">Топ 50 потока</option>
            </select>
          </label>
        </Form>

        {/* Filters auto-submit on change; announce the swap for screen-reader users (WCAG 4.1.3). */}
        <p className="sr-only" role="status">
          {navigating ? 'Обновяване на визуализацията…' : 'Визуализацията е обновена.'}
        </p>

        {unknownSector || unknownYear ? (
          <Callout variant="warning" title="Няма данни за избрания обхват">
            {unknownSector
              ? 'Избраният сектор не съответства на нито една категория от номенклатурата CPV.'
              : `Избраната година е извън периода ${range}.`}{' '}
            Виж <Link to="/flows">всички данни</Link> или избери стойност от списъка по-горе.
          </Callout>
        ) : (
          <>
            <Callout>
              <strong>Как се чете:</strong> всеки поток е сборът от договорите между една институция
              и една компания за избрания обхват. Схемата е илюстративна — точните стойности са в
              таблицата по-долу.
            </Callout>

            <SankeyDiagram layout={data.sankey} />

            <div className="flow-tooltip">
              <strong>Какво показва тази картина</strong>
              Най-дебелите потоци показват доминиращи получатели (една компания, поглъщаща голяма
              част от един възложител) и устойчиви зависимости (институция, чиито пари отиват почти
              изцяло към 2–3 компании). Дебелината показва само сумата — не и дали концентрацията е
              оправдана. Затова всеки поток се свежда до конкретните си договори в таблицата.
            </div>
          </>
        )}

        <Section
          id="scenarios"
          title="Готови изгледи"
          hint="Готови филтри върху същата визуализация."
        >
          <div className="tiles">
            {[
              {
                href: '/flows?sector=45',
                title: 'Строителство — топ потоци',
                desc: 'Кои възложители плащат на кои строителни компании.',
              },
              {
                href: '/flows?sector=33',
                title: 'Медицина и лекарства',
                desc: 'Кои болници и министерства купуват от кои доставчици.',
              },
              {
                href: '/flows?sector=09',
                title: 'Горива и енергия',
                desc: 'Енергийните доставки и техните получатели.',
              },
              {
                href: '/flows?funding=eu',
                title: 'Само с финансиране от ЕС',
                desc: 'Потоците, финансирани по европейски програми.',
              },
            ].map((t) => (
              <article className="tile" key={t.href}>
                <p className="kicker info">Сценарий</p>
                <h3>
                  <Link to={t.href}>{t.title}</Link>
                </h3>
                <p className="desc">{t.desc}</p>
              </article>
            ))}
          </div>
        </Section>

        {!unknownSector && !unknownYear && (
          <Section
            id="top-flows"
            title={`Топ ${data.scope.top} потока — табличен изглед`}
            hint="Най-големите потоци за избрания обхват."
          >
            <div className="table-wrap tbl-cards">
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Институция</th>
                    <th scope="col">Компания</th>
                    <th scope="col" className="num">
                      Сума
                    </th>
                    <th scope="col" className="num">
                      Договори
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.pairs.map((p) => (
                    <tr key={`${p.authoritySlug}-${p.bidderSlug}`}>
                      <td className="rank cell-rank" data-label="#">
                        {p.rank}
                      </td>
                      <td className="cell-title" data-label="Институция">
                        <Link to={`/authorities/${p.authoritySlug}`}>{p.authorityName}</Link>
                      </td>
                      <td data-label="Компания">
                        <Link to={`/companies/${p.bidderSlug}`}>{p.bidderDisplayName}</Link>
                      </td>
                      <td className="money" data-label="Сума">
                        {money(p.wonEur)}
                      </td>
                      <td className="money" data-label="Договори">
                        {count(p.contracts)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
              Зад всеки ред стоят неговите договори:{' '}
              <Link to="/contracts?sort=value-desc">виж договорите →</Link>
            </p>
          </Section>
        )}
      </main>
    </>
  );
}
