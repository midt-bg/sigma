import type { Route } from './+types/impressum';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { publicCache } from '../lib/cache';
import { contactEmail } from '../lib/contact';
import { seoMeta } from '../lib/meta';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import { useTranslation } from '../i18n/context';

export function meta({ matches, location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return seoMeta({
    matches,
    path: '/impressum',
    title: t('impressum.metaTitle'),
    description: t('impressum.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export function loader({ context }: Route.LoaderArgs) {
  return { contact: contactEmail(context.cloudflare.env) };
}

export default function Impressum({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  return (
    <>
      <Breadcrumbs items={[{ label: t('nav.home'), to: '/' }, { label: t('impressum.crumb') }]} />
      <main id="main">
        <PageHeader
          kicker={t('impressum.kicker')}
          title={t('impressum.title')}
          lede={t('impressum.lede')}
        />

        <section className="section" aria-labelledby="operator">
          <h2 id="operator">{t('impressum.sections.operator.heading')}</h2>
          <dl className="facts">
            <div className="row">
              <dt>{t('impressum.sections.operator.providerLabel')}</dt>
              <dd>{t('impressum.sections.operator.providerValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('impressum.sections.operator.addressLabel')}</dt>
              <dd>{t('impressum.sections.operator.addressValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('impressum.sections.operator.emailLabel')}</dt>
              <dd>
                <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>
              </dd>
            </div>
          </dl>
        </section>

        <section className="section" aria-labelledby="service">
          <h2 id="service">{t('impressum.sections.service.heading')}</h2>
          <p>{t('impressum.sections.service.body')}</p>
        </section>
      </main>
    </>
  );
}
