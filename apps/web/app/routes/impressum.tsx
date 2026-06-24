import type { Route } from './+types/impressum';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { publicCache } from '../lib/cache';
import { contactEmail } from '../lib/contact';
import { seoMeta } from '../lib/meta';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/impressum',
    title: 'Импресум — СИГМА',
    description:
      'Информация за оператора на СИГМА и контакт по чл. 4 от Закона за електронната търговия.',
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export function loader({ context }: Route.LoaderArgs) {
  return { contact: contactEmail(context.cloudflare.env) };
}

export default function Impressum({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Импресум' }]} />
      <main id="main">
        <PageHeader
          kicker="Правна информация"
          title="Импресум"
          lede="Информация за доставчика на услугата по чл. 4 от Закона за електронната търговия."
        />

        <section className="section" aria-labelledby="operator">
          <h2 id="operator">Оператор</h2>
          <dl className="facts">
            <div className="row">
              <dt>Доставчик</dt>
              <dd>Министерство на иновациите и дигиталната трансформация (МИДТ)</dd>
            </div>
            <div className="row">
              <dt>Адрес</dt>
              <dd>ул. „Княз Александър I&quot; № 12, София 1000</dd>
            </div>
            <div className="row">
              <dt>Електронна поща</dt>
              <dd>
                <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>
              </dd>
            </div>
          </dl>
        </section>

        <section className="section" aria-labelledby="service">
          <h2 id="service">Услуга</h2>
          <p>
            СИГМА е публична информационна услуга за преглед и анализ на отворени данни за
            обществени поръчки. Данните се показват без регистрация и без потребителско профилиране.
          </p>
        </section>
      </main>
    </>
  );
}
