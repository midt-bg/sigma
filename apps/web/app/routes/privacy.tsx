import { Link } from '../i18n/Link';
import type { Route } from './+types/privacy';
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
    path: '/privacy',
    title: t('privacy.metaTitle'),
    description: t('privacy.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export function loader({ context }: Route.LoaderArgs) {
  return { contact: contactEmail(context.cloudflare.env) };
}

export default function Privacy({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  return (
    <>
      <Breadcrumbs items={[{ label: t('nav.home'), to: '/' }, { label: t('privacy.crumb') }]} />
      <main id="main">
        <PageHeader
          kicker={t('privacy.kicker')}
          title={t('privacy.title')}
          lede={t('privacy.lede')}
        />

        <section className="section" aria-labelledby="controller">
          <h2 id="controller">{t('privacy.sections.controller.heading')}</h2>
          <dl className="facts">
            <div className="row">
              <dt>{t('privacy.sections.controller.controllerLabel')}</dt>
              <dd>{t('privacy.sections.controller.controllerValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('privacy.sections.controller.addressLabel')}</dt>
              <dd>{t('privacy.sections.controller.addressValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('privacy.sections.controller.contactLabel')}</dt>
              <dd>
                <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>
              </dd>
            </div>
          </dl>
        </section>

        <section className="section" aria-labelledby="data">
          <h2 id="data">{t('privacy.sections.data.heading')}</h2>
          <p>{t('privacy.sections.data.body1')}</p>
          <p>{t('privacy.sections.data.body2')}</p>
        </section>

        <section className="section" aria-labelledby="basis">
          <h2 id="basis">{t('privacy.sections.basis.heading')}</h2>
          <p>{t('privacy.sections.basis.body1')}</p>
          <p>{t('privacy.sections.basis.body2')}</p>
        </section>

        <section className="section" aria-labelledby="rights">
          <h2 id="rights">{t('privacy.sections.rights.heading')}</h2>
          <p>{t('privacy.sections.rights.body1')}</p>
          <p>
            {t('privacy.sections.rights.body2Prefix')}{' '}
            <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>
            {t('privacy.sections.rights.body2Suffix')}
          </p>
        </section>

        <section className="section" aria-labelledby="logs">
          <h2 id="logs">{t('privacy.sections.logs.heading')}</h2>
          <p>{t('privacy.sections.logs.body1')}</p>
          <p>{t('privacy.sections.logs.body2')}</p>
          <p>{t('privacy.sections.logs.body3')}</p>
          <p>{t('privacy.sections.logs.body4')}</p>
        </section>

        <section className="section" aria-labelledby="retention">
          <h2 id="retention">{t('privacy.sections.retention.heading')}</h2>
          <p>{t('privacy.sections.retention.body1')}</p>
          <p>
            {t('privacy.sections.retention.operatorPrefix')}
            <Link to="/impressum">{t('privacy.sections.retention.operatorLink')}</Link>
            {t('privacy.sections.retention.operatorSuffix')}
          </p>
        </section>
      </main>
    </>
  );
}
