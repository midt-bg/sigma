import { Link } from 'react-router';
import { getOfficialConflicts, personIdFromSlug } from '@sigma/db';
import type { Route } from './+types/conflict.official';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section, Callout } from '../components/ui';
import { ConflictCards } from '../components/ConflictCards';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

// One office-holder's declared ownership links. Reads private-ownership interest_links only. 404 (not an
// empty page) when the person has no published link — a bare page under someone's name reads as an
// unfounded accusation.
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
  const db = context.cloudflare.env.DB;
  const data = await withDbRetry(() => getOfficialConflicts(db, personId));
  if (!data) throw new Response('Not Found', { status: 404 });
  return data;
}

export default function ConflictOfficial({ loaderData }: Route.ComponentProps) {
  const { official, links } = loaderData;
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
          kicker="Длъжностно лице"
          title={official}
          lede="Дружества, спечелили обществени поръчки, в които това лице е декларирало дял пред КПКОНПИ — свой или на свързано лице. Всяка връзка е точно съвпадение по фирмено име — деклариран интерес, не установено нарушение."
        />

        <Callout titleAs="h2" title="Източник и обхват">
          <p className="m-0">
            Данните са от собствените декларации на лицето (публичен регистър на КПКОНПИ),
            съпоставени точно с регистъра на изпълнителите. Показваме само 100% съвпадения и само
            деклариран дял. Сигнал за неточност:{' '}
            <Link to="/conflicts/methodology#contest">Методология → Поправки</Link>.
          </p>
        </Callout>

        <Section
          id="holdings"
          title="Деклариран дял в компании изпълнители"
          hint="Дружества, спечелили обществени поръчки, в които лицето е декларирало дял — свой или на свързано лице. Подредени по силата на връзката."
        >
          <ConflictCards
            links={links}
            caption={`Деклариран дял на ${official} в компании изпълнители`}
            omit="official"
          />
        </Section>
      </main>
    </>
  );
}
