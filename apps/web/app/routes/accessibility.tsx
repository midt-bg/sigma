import type { Route } from './+types/accessibility';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { publicCache } from '../lib/cache';
import { contactEmail } from '../lib/contact';
import { seoMeta } from '../lib/meta';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/accessibility',
    title: 'Декларация за достъпност — СИГМА',
    description: 'Декларация за достъпност на публичната информационна услуга СИГМА.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export function loader({ context }: Route.LoaderArgs) {
  return { contact: contactEmail(context.cloudflare.env) };
}

export default function Accessibility({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Достъпност' }]} />
      <main id="main">
        <PageHeader
          kicker="Правна информация"
          title="Декларация за достъпност"
          lede="Настоящата декларация описва състоянието на достъпността на СИГМА и начина за подаване на сигнали за затруднен достъп."
        />

        <section className="section" aria-labelledby="scope">
          <h2 id="scope">Обхват</h2>
          <p>
            Тази декларация се отнася за публичната информационна услуга СИГМА, достъпна чрез този
            уебсайт.
          </p>
        </section>

        <section className="section" aria-labelledby="status">
          <h2 id="status">Състояние на съответствие</h2>
          <p>
            Уебсайтът е частично съответстващ на EN 301 549 и WCAG 2.1 ниво AA поради посочените
            по-долу несъответствия и елементи в процес на отстраняване.
          </p>
        </section>

        <section className="section" aria-labelledby="issues">
          <h2 id="issues">Известни несъответствия и елементи в процес на отстраняване</h2>
          <ul>
            <li>
              На някои страници заглавие от приставката за достъпност предхожда H1 на страницата.
              Това е в процес на отстраняване.
            </li>
            <li>
              Някои интерактивни елементи са под минималния размер 24x24px. Това е в процес на
              отстраняване.
            </li>
            <li>
              Приставката за достъпност (на ИО АД) е допълнително удобство и не служи като основание
              за съответствие.
            </li>
          </ul>
        </section>

        <section className="section" aria-labelledby="preparation">
          <h2 id="preparation">Изготвяне на декларацията</h2>
          <dl className="facts">
            <div className="row">
              <dt>Дата на изготвяне</dt>
              <dd>07.06.2026</dd>
            </div>
            <div className="row">
              <dt>Последен преглед</dt>
              <dd>07.06.2026</dd>
            </div>
            <div className="row">
              <dt>Метод</dt>
              <dd>Самооценка, автоматизиран одит и ръчен одит.</dd>
            </div>
          </dl>
        </section>

        <section className="section" aria-labelledby="feedback">
          <h2 id="feedback">Обратна връзка и контакт</h2>
          <p>
            Ако срещнете затруднение при достъп до съдържание или функционалност, изпратете сигнал
            на <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>. Опишете страницата
            или URL адреса, засегнатата функционалност и използваната помощна технология, когато е
            приложимо.
          </p>
        </section>

        <section className="section" aria-labelledby="enforcement">
          <h2 id="enforcement">Процедура по прилагане</h2>
          <p>
            Ако подаден сигнал за бариера не бъде разгледан или не получите удовлетворителен
            отговор, можете да го отнесете към Министерството на електронното управление (МЕУ).
          </p>
          <p>
            Уебсайт на МЕУ:{' '}
            <a href="https://egov.government.bg" rel="noreferrer">
              https://egov.government.bg
            </a>
          </p>
        </section>
      </main>
    </>
  );
}
