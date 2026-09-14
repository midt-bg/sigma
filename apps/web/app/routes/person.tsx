import { getDb, getRegistrySourceCompanies, registryPersonIdFromSlug } from '@sigma/db';
import { data, Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
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
    title: `${data && 'name' in data ? personName(data.name) : 'Лице'} — СИГМА`,
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
  if (!profile) {
    const sources = await withDbRetry(() =>
      getRegistrySourceCompanies(getDb(context.cloudflare.env), indent),
    );
    if (sources.length) return data({ sources }, { headers: { 'X-Robots-Tag': 'noindex' } });
    throw new Response('Not Found', { status: 404 });
  }
  return data(profile, { headers: { 'X-Robots-Tag': 'noindex' } });
}
export default function Person({ loaderData }: Route.ComponentProps) {
  if ('sources' in loaderData)
    return (
      <>
        <PageHeader
          kicker="Търговски регистър"
          title="Източникови записи"
          lede="Този стар адрес събира записи с еднаква дата на раждане. Тя не е достатъчна, за да установим, че става дума за един човек. Ролите са достъпни при съответното дружество."
        />
        <DataTable
          rows={loaderData.sources}
          getKey={(r) => `${r.eik}:${r.name}`}
          variant="prose"
          columns={[
            {
              key: 'name',
              header: 'Име в регистъра',
              isTitle: true,
              cell: (r) => personName(r.name),
            },
            {
              key: 'company',
              header: 'Дружество',
              cell: (r) => (r.href ? <Link to={r.href}>{r.company}</Link> : r.company),
            },
            { key: 'eik', header: 'ЕИК', cell: (r) => r.eik },
          ]}
        />
      </>
    );
  return <PersonProfile profile={loaderData} />;
}
