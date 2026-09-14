import { getDb, getPersonDestinations, personIdFromSlug, personSlug } from '@sigma/db';
import { Link, redirect } from 'react-router';
import type { Route } from './+types/conflict.official';
import { PersonProfile } from '../components/PersonProfile';
import { loadPersonProfile } from '../lib/person-profile.server';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { personName } from '../lib/person-name';
import { PageHeader } from '../components/PageHeader';

export function meta({ data, matches, params }: Route.MetaArgs) {
  return [
    ...seoMeta({
      matches,
      path: `/conflicts/official/${params.id}`,
      title: `${data && 'name' in data ? personName(data.name) : 'Длъжностно лице'} — СИГМА`,
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
  if (!profile) throw new Response('Not Found', { status: 404 });
  return profile;
}
export default function ConflictOfficial({ loaderData }: Route.ComponentProps) {
  if ('destinations' in loaderData)
    return (
      <>
        <PageHeader
          kicker="Длъжностни лица"
          title="Избери профил"
          lede="Този стар адрес включва записи, за които не е установена една обща самоличност."
        />
        <ul>
          {loaderData.destinations.map((p) => (
            <li key={p.id}>
              <Link to={`/conflicts/official/${personSlug(p.id)}?view=profile`}>
                {personName(p.name)}
              </Link>
              {p.institutions && <p>{p.institutions}</p>}
            </li>
          ))}
        </ul>
      </>
    );
  return <PersonProfile profile={loaderData} />;
}
