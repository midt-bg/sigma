import { Link } from 'react-router';
import type { Route } from './+types/analytics';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section } from '../components/ui';
import { publicCache } from '../lib/cache';
import { seoMeta } from '../lib/meta';

const LENSES = [
  {
    href: '/flows',
    title: 'Потоци',
    desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
  },
  {
    href: '/map',
    title: 'Карта',
    desc: 'Къде по области се концентрират разходите за обществени поръчки.',
  },
  {
    href: '/trends',
    title: 'Тренд',
    desc: 'Как се движат разходите във времето по месеци и години.',
  },
  {
    href: '/network',
    title: 'Мрежа',
    desc: 'Кои връзки се виждат около избрана институция или фирма.',
  },
  {
    href: '/competition',
    title: 'Конкуренция',
    desc: 'Къде има висок дял „една оферта“ и концентрация на доставчици.',
  },
];

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/analytics',
    title: 'Анализи — СИГМА',
    description:
      'Пет аналитични изгледа към обществените поръчки: потоци, карта, тренд, мрежа и конкуренция.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

export default function Analytics() {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Анализи' }]} />
      <main id="main">
        <PageHeader
          kicker="Анализи"
          title="Анализи"
          lede="Пет начина да проследиш едни и същи обществени поръчки: като движение на пари, карта, времева линия, мрежа от връзки и сигнал за слаба конкуренция."
        />

        <Section
          id="lenses"
          title="Изгледи"
          hint="Всеки изглед отговаря на различен въпрос, но всички водят обратно към конкретните договори."
        >
          <div className="tiles">
            {LENSES.map((lens) => (
              <article className="tile" key={lens.href}>
                <p className="kicker info">Изглед</p>
                <h3>
                  <Link to={lens.href}>{lens.title}</Link>
                </h3>
                <p className="desc">{lens.desc}</p>
              </article>
            ))}
          </div>
        </Section>
      </main>
    </>
  );
}
