import { getDb, registryPersonIdFromSlug } from '@sigma/db';
import { data } from 'react-router';
import type { Route } from './+types/person';
import { PersonProfile } from '../components/PersonProfile';
import { loadPersonProfile } from '../lib/person-profile.server';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { personName } from '../lib/person-name';

export function meta({ data, params, matches }: Route.MetaArgs) {
  const tags = seoMeta({
    matches,
    path: `/persons/${params.id}`,
    title: `${data?.name ? personName(data.name) : 'Лице'} — СИГМА`,
    description: 'Роли, декларации и обществени поръчки на свързаните дружества.',
  });
  tags.push({ name: 'robots', content: 'noindex' });
  return tags;
}
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const headers = new Headers({ 'Cache-Control': publicCache(3600) });
  headers.set('X-Robots-Tag', 'noindex');
  return headers;
}
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const indent = registryPersonIdFromSlug(params.id ?? '');
  if (!indent) throw new Response('Not Found', { status: 404 });
  const profile = await withDbRetry(() =>
    loadPersonProfile(getDb(context.cloudflare.env), {
      indent,
      search: new URL(request.url).searchParams,
    }),
  );
  if (!profile) throw new Response('Not Found', { status: 404 });
  return data(profile, { headers: { 'X-Robots-Tag': 'noindex' } });
}
export default function Person({ loaderData }: Route.ComponentProps) {
  return <PersonProfile profile={loaderData} />;
}
