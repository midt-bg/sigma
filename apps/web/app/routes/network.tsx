import { Form, useNavigation, useSubmit } from 'react-router';
import { Link } from '../i18n/Link';
import { count, money } from '@sigma/shared';
import { useTranslation, useLocale } from '../i18n/context';
import { makeT } from '../i18n/t';
import { getLocale } from '../i18n/locale';
import {
  authorityIdFromSlug,
  bidderIdFromSlug,
  getEntityNetwork,
  type NetworkParams,
} from '@sigma/db';
import type { Route } from './+types/network';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { NetworkGraph } from '../components/NetworkGraph';
import { Callout, Section } from '../components/ui';
import { publicCache } from '../lib/cache';

export function meta({ location }: Route.MetaArgs) {
  const t = makeT(getLocale(location.pathname));
  return [
    { title: t('network.metaTitle') },
    {
      name: 'description',
      content: t('network.metaDescription'),
    },
  ];
}

export function headers() {
  return { 'Cache-Control': publicCache(1800) };
}

// ?center=a:<eik> | c:<slug>; null falls back to the biggest authority in the query layer.
function parseCenter(token: string | null): NetworkParams | null {
  if (!token) return null;
  const i = token.indexOf(':');
  if (i < 1) return null;
  const kind = token.slice(0, i);
  const slug = token.slice(i + 1);
  if (kind === 'a' && slug) return { kind: 'authority', id: authorityIdFromSlug(slug) };
  if (kind === 'c' && slug) {
    const id = bidderIdFromSlug(slug);
    return id ? { kind: 'company', id } : null;
  }
  return null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const center = parseCenter(new URL(request.url).searchParams.get('center'));
  const data = await getEntityNetwork(context.cloudflare.env.DB, center, {}, getLocale(request));
  // A well-formed but non-existent ?center should 404 like the other entity pages, not render an
  // empty 200 that then gets edge-cached. A missing or malformed ?center keeps the default centre.
  if (center && !data.center) {
    throw new Response('Not Found', { status: 404 });
  }
  return { data };
}

interface LinkRow {
  from: string;
  to: string;
  valueEur: number;
  contracts: number;
}

export default function Network({ loaderData }: Route.ComponentProps) {
  const { data } = loaderData;
  const t = useTranslation();
  const locale = useLocale();
  const submit = useSubmit();
  const navigating = useNavigation().state !== 'idle';
  const centerValue = data.center
    ? `${data.center.kind === 'authority' ? 'a' : 'c'}:${data.center.slug}`
    : '';

  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  // Normalise each row to the real procurement direction (authority -> company), regardless of how the
  // edge is oriented in the graph topology: the institution awards and pays the company, never the
  // reverse. Every edge connects one authority and one company.
  const rows: LinkRow[] = data.edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    const authority = a?.kind === 'authority' ? a : b;
    const company = a?.kind === 'authority' ? b : a;
    return {
      from: authority?.label ?? e.from,
      to: company?.label ?? e.to,
      valueEur: e.valueEur,
      contracts: e.contracts,
    };
  });
  const columns: Column<LinkRow>[] = [
    { key: 'from', header: t('network.colFrom'), isTitle: true, cell: (r) => r.from },
    { key: 'to', header: t('network.colTo'), cell: (r) => r.to },
    {
      key: 'value',
      header: t('network.colValue'),
      align: 'money',
      cell: (r) => money(r.valueEur, locale),
    },
    {
      key: 'contracts',
      header: t('network.colContracts'),
      align: 'num',
      secondary: true,
      cell: (r) => count(r.contracts, locale),
    },
  ];

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t('network.breadcrumbHome'), to: '/' },
          { label: t('network.breadcrumbNetwork') },
        ]}
      />
      <main id="main">
        <PageHeader
          kicker={t('network.kicker')}
          title={t('network.title')}
          lede={t('network.lede')}
        />

        <Form
          method="get"
          className="flow-controls"
          role="group"
          aria-label={t('network.controlsAria')}
          onChange={(e) => submit(e.currentTarget)}
        >
          <label>
            {t('network.centerLabel')}
            <select name="center" defaultValue={centerValue}>
              <optgroup label={t('network.groupAuthorities')}>
                {data.centerOptions.authorities.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('network.groupCompanies')}>
                {data.centerOptions.companies.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </Form>

        <p className="sr-only" role="status">
          {navigating ? t('network.statusUpdating') : t('network.statusUpdated')}
        </p>

        {data.center && data.nodes.length >= 2 ? (
          <>
            <Section
              id="graph"
              title={
                <>
                  {t('network.graphTitlePre')} <em>{data.center.label}</em>
                </>
              }
              hint={t('network.graphHint')}
            >
              <NetworkGraph data={data} />
            </Section>

            <Section id="links" title={t('network.linksTitle')}>
              <DataTable
                columns={columns}
                rows={rows}
                getKey={(r) => `${r.from}-${r.to}`}
                caption={t('network.linksCaption')}
              />
            </Section>
          </>
        ) : (
          <Callout variant="warning" title={t('network.emptyTitle')}>
            <p style={{ margin: 0 }}>{t('network.emptyBody')}</p>
          </Callout>
        )}

        <Callout title={t('network.aboutTitle')}>
          <p style={{ margin: 0 }}>
            {t('network.aboutPre')} <Link to="/flows">{t('network.aboutLink')}</Link>
            {t('network.aboutPost')}
          </p>
        </Callout>
      </main>
    </>
  );
}
