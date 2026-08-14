import { Link } from 'react-router';
import { getOfficialConflicts, personIdFromSlug, getDb } from '@sigma/db';
import type { Route } from './+types/conflict.official';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section, Callout } from '../components/ui';
import { ConflictDetail } from '../components/ConflictDetail';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { declaredStakeNoun } from '../lib/conflicts';

// One office-holder's declared ownership links. Reads published interest_links, which per ADR-0032
// include a close relative's declared stake alongside the person's own — the relative is never named and
// the relationship never asserted. 404 (not an empty page) when the person has no published link — a bare
// page under someone's name reads as an unfounded accusation.
export function meta({ data, matches, params }: Route.MetaArgs) {
  const name = data?.official ?? 'Длъжностно лице';
  const tags = seoMeta({
    matches,
    path: `/conflicts/official/${params.id}`,
    title: `${name} — свързани лица — СИГМА`,
    description: `Деклариран дял на ${name} в дружества, спечелили обществени поръчки.`,
  });
  tags.push({ name: 'robots', content: 'noindex' }); // names an individual — not indexed
  return tags;
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const personId = personIdFromSlug(params.id);
  if (!personId) throw new Response('Not Found', { status: 404 });
  const db = getDb(context.cloudflare.env);
  const data = await withDbRetry(() => getOfficialConflicts(db, personId));
  if (!data) throw new Response('Not Found', { status: 404 });
  return data;
}

export default function ConflictOfficial({ loaderData }: Route.ComponentProps) {
  const { official, links, contracts } = loaderData;
  // Family-AWARE, not family-blind: the page must not assert an own stake above cards that say „свързано
  // лице", and must not go vague where the stake really is the official's own (§2.6).
  const stake = declaredStakeNoun(links);
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          { label: 'Свързани лица', to: '/conflicts' },
          { label: official },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={links[0]?.institution ?? 'Длъжностно лице'}
          title={official}
          lede={`Дружества, спечелили обществени поръчки, за които това лице е декларирало ${stake} пред КПКОНПИ. Всяка връзка почива на проверим факт от Търговския регистър — деклариран интерес, не установено нарушение.`}
        />

        <Callout titleAs="h2" title="Източник и обхват">
          <p className="m-0">
            Данните са от декларациите на лицето пред КПКОНПИ (публичен регистър), съпоставени точно
            с регистъра на изпълнителите. Показваме деклариран дял — собствен или на свързано лице;
            името на близкия не се показва и видът на връзката не се твърди. Показваме само 100%
            съвпадения, и само когато самоличността на дружеството е потвърдена от Търговския
            регистър. Сигнал за неточност:{' '}
            <Link to="/conflicts/methodology#contest">Методология → Поправки</Link>.
          </p>
        </Callout>

        <Section
          id="holdings"
          title="Деклариран дял в компании изпълнители"
          hint={`Дружества, спечелили обществени поръчки, за които лицето е декларирало ${stake}. Подредени по силата на връзката.`}
        >
          <ConflictDetail links={links} contracts={contracts} perspective="official" />
        </Section>
      </main>
    </>
  );
}
