import { getDb, getRegistryPerson, registryPersonIdFromSlug } from '@sigma/db';
import { count, money, plural } from '@sigma/shared';
import type { Route } from './+types/person';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { FactsList } from '../components/FactsList';
import { DataTable } from '../components/DataTable';
import { TieGraph } from '../components/TieGraph';
import { PersonRolesTables, RegistrySource } from '../components/RegistryRoles';
import { Section } from '../components/ui';
import { layoutTies } from '../lib/tie-layout.server';
import { tieColumns, tieRows } from '../lib/entity-tables';
import { publicCache } from '../lib/cache';
import { withDbRetry } from '../lib/retry';
import { seoMeta } from '../lib/meta';

// A natural person as the Trade Register records them (ADR-0039): the roles they hold or held at companies
// that won public procurement, each with its dates and the entry it rests on, and the graph of those
// companies. 404 — never an empty page — for an identifier the register never gave, and for a person it
// records only in a role the site does not show.

export function meta({ data, params, matches }: Route.MetaArgs) {
  const name = data?.person.name ?? 'Лице';
  return seoMeta({
    matches,
    path: `/persons/${params.id}`,
    title: `${name} — СИГМА`,
    description: `Роли на ${name} в дружества, спечелили обществени поръчки, по данни от Търговския регистър.`,
  });
}

export function headers() {
  return { 'Cache-Control': publicCache(3600) };
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const indent = registryPersonIdFromSlug(params.id ?? '');
  if (!indent) throw new Response('Not Found', { status: 404 });
  const db = getDb(context.cloudflare.env);
  const person = await withDbRetry(() => getRegistryPerson(db, indent));
  if (!person) throw new Response('Not Found', { status: 404 });
  return { person, tieLayout: layoutTies(person.network) };
}

export default function Person({ loaderData }: Route.ComponentProps) {
  const { person, tieLayout } = loaderData;
  const standing = person.roles.filter((r) => !r.removedOn).length;
  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: person.name }]} />
      <main id="main">
        <PageHeader
          kicker="Лице · Търговски регистър"
          title={person.name}
          lede="Роли в дружества, спечелили обществени поръчки, както са вписани в Търговския регистър."
        />

        <FactsList
          label="Ключови показатели"
          rows={[
            {
              term: 'Дружества',
              value: `${count(person.companies)} ${plural(person.companies, 'дружество', 'дружества')}`,
            },
            { term: 'Роли в сила', value: count(standing) },
            {
              term: 'Спечелено от дружествата',
              value: money(person.wonEur),
              sub: 'по обществени поръчки, от всички тези дружества заедно',
            },
          ]}
        />

        {tieLayout && (
          <Section
            id="network"
            title="Дружества"
            hint="Дружествата, в които лицето има или е имало роля по Търговския регистър."
          >
            <TieGraph layout={tieLayout} />
            <div className="sr-only">
              <DataTable
                columns={tieColumns}
                rows={tieRows(person.network)}
                getKey={(r) => `${r.from}-${r.to}-${r.kind}`}
                caption="Дружества на лицето"
              />
            </div>
            {person.network.omitted > 0 && (
              <p className="small muted mt-s3">
                Показани са {count(person.network.nodes.length - 1)}; още{' '}
                {count(person.network.omitted)} са извън схемата.
              </p>
            )}
          </Section>
        )}

        <Section
          id="roles"
          title="Роли"
          hint="Всяка роля с датата на вписването, което я добавя, а прекратената — и с датата на вписването, което я прекратява."
        >
          <PersonRolesTables roles={person.roles} />
          <RegistrySource asOf={person.asOf} />
        </Section>
      </main>
    </>
  );
}
