import { Link } from 'react-router';
import { count, plural } from '@sigma/shared';
import { getCompanyConflicts, getDb } from '@sigma/db';
import type { Route } from './+types/conflict.company';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section, Callout, ExternalEikLink } from '../components/ui';
import { ConflictDetail } from '../components/ConflictDetail';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { companyProfileHref, declaredStakeNoun } from '../lib/conflicts';

// Officials with a published declared interest in one winner (by ЕИК). Reads published interest_links,
// which per ADR-0032 include a stake declared for a close relative alongside the official's own — the
// relative is never named and the relationship never asserted. 404 when no official has a published link to
// this company — never an empty page under a company's name.
export function meta({ data, matches, params }: Route.MetaArgs) {
  const name = data?.company ?? 'Дружество';
  const tags = seoMeta({
    matches,
    path: `/conflicts/company/${params.eik}`,
    title: `${name} — свързани лица — СИГМА`,
    description: `Длъжностни лица, декларирали дял в ${name} (ЕИК ${params.eik}).`,
  });
  tags.push({ name: 'robots', content: 'noindex' }); // names individuals — not indexed (delivery plan §E10)
  return tags;
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // A БГ ЕИК is 9 or 13 digits — always numeric. Require digits (not just non-blank) so a garbage/probe
  // :eik 404s before any DB read and before it reaches meta/URL — uniform with the sibling conflict loaders.
  if (!/^\d+$/.test(params.eik ?? '')) throw new Response('Not Found', { status: 404 });
  const db = getDb(context.cloudflare.env);
  const data = await withDbRetry(() => getCompanyConflicts(db, params.eik));
  if (!data) throw new Response('Not Found', { status: 404 });
  return data;
}

export default function ConflictCompany({ loaderData }: Route.ComponentProps) {
  const { company, eik, links, contracts } = loaderData;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Свързани лица', to: '/conflicts' },
          { label: company },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={
            <>
              Дружество · ЕИК&nbsp;{eik}
              <ExternalEikLink eik={eik} />
            </>
          }
          title={company}
          lede={`Длъжностни лица, декларирали ${declaredStakeNoun(links)} в това дружество пред КПКОНПИ. ${count(links.length)} ${plural(links.length, 'връзка', 'връзки')} — всяка почива на проверим факт от Търговския регистър.`}
        />

        <Callout titleAs="h2" title="Източник и обхват">
          <p className="m-0">
            Връзките са от декларациите на длъжностните лица пред КПКОНПИ (публичен регистър) —
            деклариран дял, собствен или на свързано лице; името на близкия не се показва и видът на
            връзката не се твърди. Съпоставени са точно с този изпълнител. Виж и{' '}
            <Link to={companyProfileHref(eik)}>профила на дружеството</Link> в обществените поръчки.
            Сигнал за неточност:{' '}
            <Link to="/conflicts/methodology#contest">Методология → Поправки</Link>.
          </p>
        </Callout>

        <Section
          id="officials"
          title="Длъжностни лица с деклариран дял"
          hint="Подредени по силата на връзката: първо договори от собствената институция, после дял към момента на договора."
        >
          <ConflictDetail links={links} contracts={contracts} perspective="company" />
        </Section>
      </main>
    </>
  );
}
