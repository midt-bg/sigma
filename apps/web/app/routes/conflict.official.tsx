import { getDb, getRegistryIdentity, getRegistryPerson, personIdFromSlug } from '@sigma/db';
import type { Route } from './+types/conflict.official';
import { PersonProfile } from '../components/PersonProfile';
import { loadPersonProfile } from '../lib/person-profile.server';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

export function meta({ data, matches, params }: Route.MetaArgs) {
  return [
    ...seoMeta({
      matches,
      path: `/conflicts/official/${params.id}`,
      title: `${data?.name ?? 'Длъжностно лице'} — СИГМА`,
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
  const indent = await withDbRetry(() => getRegistryIdentity(db, id));
  const registry = indent && (await withDbRetry(() => getRegistryPerson(db, indent)));
  const profile = await withDbRetry(() =>
    loadPersonProfile(
      db,
      registry
        ? { indent: indent!, search: url.searchParams }
        : { officialId: id, search: url.searchParams },
    ),
  );
  if (!profile) throw new Response('Not Found', { status: 404 });
  return profile;
}
export default function ConflictOfficial({ loaderData }: Route.ComponentProps) {
  return <PersonProfile profile={loaderData} />;
}
