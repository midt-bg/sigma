import type { Route } from './+types/accessibility';
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
    path: '/accessibility',
    title: t('accessibility.metaTitle'),
    description: t('accessibility.metaDescription'),
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export function loader({ context }: Route.LoaderArgs) {
  return { contact: contactEmail(context.cloudflare.env) };
}

export default function Accessibility({ loaderData }: Route.ComponentProps) {
  const t = useTranslation();
  return (
    <>
      <Breadcrumbs
        items={[{ label: t('nav.home'), to: '/' }, { label: t('accessibility.crumb') }]}
      />
      <main id="main">
        <PageHeader
          kicker={t('accessibility.kicker')}
          title={t('accessibility.title')}
          lede={t('accessibility.lede')}
        />

        <section className="section" aria-labelledby="scope">
          <h2 id="scope">{t('accessibility.sections.scope.heading')}</h2>
          <p>{t('accessibility.sections.scope.body')}</p>
        </section>

        <section className="section" aria-labelledby="status">
          <h2 id="status">{t('accessibility.sections.status.heading')}</h2>
          <p>{t('accessibility.sections.status.body')}</p>
        </section>

        <section className="section" aria-labelledby="issues">
          <h2 id="issues">{t('accessibility.sections.issues.heading')}</h2>
          <ul>
            <li>{t('accessibility.sections.issues.item1')}</li>
            <li>{t('accessibility.sections.issues.item2')}</li>
            <li>{t('accessibility.sections.issues.item3')}</li>
          </ul>
        </section>

        <section className="section" aria-labelledby="preparation">
          <h2 id="preparation">{t('accessibility.sections.preparation.heading')}</h2>
          <dl className="facts">
            <div className="row">
              <dt>{t('accessibility.sections.preparation.preparedLabel')}</dt>
              <dd>{t('accessibility.sections.preparation.preparedValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('accessibility.sections.preparation.reviewedLabel')}</dt>
              <dd>{t('accessibility.sections.preparation.reviewedValue')}</dd>
            </div>
            <div className="row">
              <dt>{t('accessibility.sections.preparation.methodLabel')}</dt>
              <dd>{t('accessibility.sections.preparation.methodValue')}</dd>
            </div>
          </dl>
        </section>

        <section className="section" aria-labelledby="feedback">
          <h2 id="feedback">{t('accessibility.sections.feedback.heading')}</h2>
          <p>
            {t('accessibility.sections.feedback.bodyPrefix')}
            <a href={`mailto:${loaderData.contact}`}>{loaderData.contact}</a>
            {t('accessibility.sections.feedback.bodySuffix')}
          </p>
        </section>

        <section className="section" aria-labelledby="enforcement">
          <h2 id="enforcement">{t('accessibility.sections.enforcement.heading')}</h2>
          <p>{t('accessibility.sections.enforcement.body1')}</p>
          <p>
            {t('accessibility.sections.enforcement.websiteLabel')}{' '}
            <a href="https://egov.government.bg" rel="noreferrer">
              https://egov.government.bg
            </a>
          </p>
        </section>
      </main>
    </>
  );
}
