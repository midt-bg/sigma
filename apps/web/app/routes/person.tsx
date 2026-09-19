import {
  getDb,
  getPersonDestinations,
  getPersonSourceArchive,
  getRegistrySourceCompanies,
  personIdFromSlug,
  personSlug,
  registryPersonIdFromSlug,
} from '@sigma/db';
import { data, Link, redirect } from 'react-router';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import type { Route } from './+types/person';
import { PersonProfile } from '../components/PersonProfile';
import { Declarations } from '../components/Declarations';
import { loadPersonProfile } from '../lib/person-profile.server';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';
import { personName } from '../lib/person-name';
import { date } from '@sigma/shared';
import { RegistrySource } from '../components/RegistryRoles';
import { registryUrl, Section } from '../components/ui';

// One address for a person. The slug is either the identifier the Trade Register publishes for them (64 hex
// characters) or the id their declarations resolved to (base64url); both lead to the same profile.
export function meta({ data, params, matches }: Route.MetaArgs) {
  const name =
    data && 'name' in data
      ? personName(data.name)
      : data && 'source' in data && data.source
        ? personName(data.source.name)
        : 'Лице';
  const tags = seoMeta({
    matches,
    path: `/persons/${params.id}`,
    title: `${name} — СИГМА`,
    description: 'Роли, декларации и обществени поръчки на свързаните дружества.',
  });
  tags.push({ name: 'robots', content: 'noindex' });
  return tags;
}
export function headers() {
  const headers = new Headers({ 'Cache-Control': publicCache(3600) });
  headers.set('X-Robots-Tag', 'noindex');
  return headers;
}
const NOINDEX = { headers: { 'X-Robots-Tag': 'noindex' } };
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const indent = registryPersonIdFromSlug(params.id ?? '');
  const officialId = indent ? null : personIdFromSlug(params.id ?? '');
  if (!indent && !officialId) throw new Response('Not Found', { status: 404 });
  const db = getDb(context.cloudflare.env);
  const url = new URL(request.url);
  if (officialId) {
    // An id from an earlier identity grain may have been carried into one or several current profiles.
    const destinations = await withDbRetry(() => getPersonDestinations(db, officialId));
    if (destinations.length > 1 && url.searchParams.get('view') !== 'profile')
      return data({ destinations }, NOINDEX);
    if (destinations.length === 1 && destinations[0]!.id !== officialId)
      throw redirect(`/persons/${personSlug(destinations[0]!.id)}${url.search}${url.hash}`, 302);
  }
  const profile = await withDbRetry(() =>
    loadPersonProfile(db, {
      indent: indent ?? undefined,
      officialId: officialId ?? undefined,
      search: url.searchParams,
    }),
  );
  if (profile) return data(profile, NOINDEX);
  if (indent) {
    const sources = await withDbRetry(() => getRegistrySourceCompanies(db, indent));
    if (sources.length) return data({ sources }, NOINDEX);
  } else {
    const source = await withDbRetry(() => getPersonSourceArchive(db, officialId!));
    if (source) return data({ source }, NOINDEX);
  }
  throw new Response('Not Found', { status: 404 });
}
export default function Person({ loaderData }: Route.ComponentProps) {
  if ('sources' in loaderData)
    return (
      <main id="main">
        <PageHeader
          kicker="Търговски регистър"
          title="Източникови записи"
          lede="Наличните сведения не са достатъчни за обединяване в общ профил. Ролите са достъпни при съответното дружество."
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
            {
              key: 'eik',
              header: 'Партида',
              cell: (r) => (
                <a href={registryUrl(r.eik)} target="_blank" rel="noopener noreferrer">
                  ЕИК {r.eik}
                  <span className="sr-only"> (в нов раздел)</span>
                </a>
              ),
            },
            { key: 'fetchedAt', header: 'Извлечено на', cell: (r) => date(r.fetchedAt) },
          ]}
        />
        <RegistrySource />
      </main>
    );
  if ('source' in loaderData)
    return (
      <main id="main">
        <PageHeader
          kicker="Декларации от източника"
          title={personName(loaderData.source.name)}
          lede="Тези документи се водят като отделен запис. Няма доказана връзка с дружество, затова страницата няма раздели за свързани дружества, роли по Търговския регистър и договори — показани са само самите декларации."
        >
          {/* The register can issue one person more than one declarant identifier, and then the filings
              stay in separate records: identity is established by evidence, never by the name (ADR-0033),
              because a namesake merged in error is the harm this rail exists to prevent. Saying so — and
              pointing at every record under the name — is the honest answer to „why are these apart?". */}
          <p className="small muted">
            Документи под същото име може да се водят в отделен запис — едно и също име не доказва
            едно и също лице.{' '}
            <Link to={`/search?q=${encodeURIComponent(loaderData.source.name)}`}>
              Виж всички записи под това име
            </Link>
            .
          </p>
        </PageHeader>
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
          lede="Под това име и институция има документи, които доказателствата разделят на отделни записи. Всеки води към своя профил. Отделните групи не означават непременно различни хора — означават само, че нищо не доказва, че са едно и също."
        />
        <ul>
          {loaderData.destinations.map((p) => (
            <li key={p.id}>
              <Link to={`/persons/${personSlug(p.id)}?view=profile`}>{personName(p.name)}</Link>
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
