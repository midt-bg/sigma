import {
  getDb,
  getPersonDestinations,
  getPersonSourceArchive,
  personIdFromSlug,
  personSlug,
} from '@sigma/db';
import { Link, redirect } from 'react-router';
import type { Route } from './+types/conflict.official';
import { PersonProfile } from '../components/PersonProfile';
import { loadPersonProfile } from '../lib/person-profile.server';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { personName } from '../lib/person-name';
import { PageHeader } from '../components/PageHeader';
import { Declarations } from '../components/Declarations';
import { Section } from '../components/ui';

export function meta({ data, matches, params }: Route.MetaArgs) {
  return [
    ...seoMeta({
      matches,
      path: `/conflicts/official/${params.id}`,
      title: `${data && 'name' in data ? personName(data.name) : data && 'source' in data && data.source ? personName(data.source.name) : 'Длъжностно лице'} — СИГМА`,
      description: 'Декларирани интереси, източници и обществени поръчки на свързаните дружества.',
    }),
    { name: 'robots', content: 'noindex' },
  ];
}
export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const id = personIdFromSlug(params.id);
  if (!id) throw new Response('Not Found', { status: 404 });
  const db = getDb(context.cloudflare.env);
  const url = new URL(request.url);
  const destinations = await withDbRetry(() => getPersonDestinations(db, id));
  if (destinations.length > 1 && url.searchParams.get('view') !== 'profile')
    return { destinations };
  if (destinations.length === 1 && destinations[0]!.id !== id)
    throw redirect(
      `/conflicts/official/${personSlug(destinations[0]!.id)}${url.search}${url.hash}`,
      302,
    );
  const profile = await withDbRetry(() =>
    loadPersonProfile(db, { officialId: id, search: url.searchParams }),
  );
  if (!profile) {
    const source = await withDbRetry(() => getPersonSourceArchive(db, id));
    if (source) return { source };
    throw new Response('Not Found', { status: 404 });
  }
  return profile;
}
export default function ConflictOfficial({ loaderData }: Route.ComponentProps) {
  if ('source' in loaderData && loaderData.source)
    return (
      <main id="main">
        <PageHeader
          kicker="Декларации от източника"
          title={personName(loaderData.source.name)}
          lede="Документите са запазени като отделен източников запис. Няма достатъчно доказателства да ги отнесем към общ профил с установена връзка с дружество."
        />
        <Section id="declarations" title="Всички декларации">
          <Declarations declarations={loaderData.source.declarations} />
        </Section>
      </main>
    );
  if ('destinations' in loaderData)
    return (
      <main id="main">
        <PageHeader
          kicker="Длъжностни лица"
          title="Профили и декларации"
          lede="Документите от стария адрес са показани според установените връзки. Отделните групи не означават непременно различни хора."
        />
        <ul>
          {loaderData.destinations.map((p) => (
            <li key={p.id}>
              <Link to={`/conflicts/official/${personSlug(p.id)}?view=profile`}>
                {personName(p.name)}
              </Link>
              <p>
                {p.kind === 'person'
                  ? 'Обединен профил'
                  : 'Декларации с непотвърдена принадлежност'}{' '}
                · {p.declaration_count} {p.declaration_count === 1 ? 'декларация' : 'декларации'}
              </p>
              {p.institutions && <p>{p.institutions}</p>}
            </li>
          ))}
        </ul>
      </main>
    );
  return <PersonProfile profile={loaderData} />;
}
