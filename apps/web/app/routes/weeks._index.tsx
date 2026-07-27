import { Link } from 'react-router';
import { money } from '@sigma/shared';
import type { Route } from './+types/weeks._index';
import { PageHeader } from '../components/PageHeader';
import { DataTable, type Column } from '../components/DataTable';
import { seoMeta } from '../lib/meta';
import { listStoredWeeks, weekRangeLabel, type WeekIndexEntry } from '../lib/weeks';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/weeks',
    title: 'Седмицата в пари — архив',
    description:
      'Архив на автоматизираните седмични обзори на обществените поръчки. Всяка седмица с публикувани данни има свой обзор.',
  });
}

export function headers() {
  // Not shared-cached (mirrors /weeks/:iso): the archive lists live R2 objects, so adding/removing a week
  // must show immediately. The worker also skips its edge cache for /weeks (apps/web/workers/app.ts); a
  // short browser max-age only avoids refetch on rapid back/forward.
  return { 'Cache-Control': 'private, max-age=60' };
}

export async function loader({ context }: Route.LoaderArgs) {
  // Only weeks WITH an artifact appear (spec §11). No D1 at serve time — the list comes from R2.
  // Before REPORTS is provisioned the archive is simply empty.
  const bucket = context.cloudflare.env.REPORTS;
  const weeks = bucket ? await listStoredWeeks(bucket) : [];
  return { weeks };
}

export default function WeeksIndex({ loaderData }: Route.ComponentProps) {
  const { weeks } = loaderData;
  const columns: Column<WeekIndexEntry>[] = [
    {
      key: 'iso',
      header: 'Седмица',
      isTitle: true,
      // Show the human Mon–Sun range; keep the href/slug on the iso (the R2 key + rowLink overlay).
      cell: (w) => <Link to={`/weeks/${w.iso}`}>{weekRangeLabel(w)}</Link>,
    },
    {
      key: 'total',
      header: 'Обща стойност (€)',
      align: 'money',
      cell: (w) => (w.totalEur != null ? money(w.totalEur) : '—'),
    },
  ];
  return (
    <main id="main">
      <PageHeader
        kicker="Седмицата в пари"
        title="Седмични обзори"
        lede="Автоматизиран обзор на обществените поръчки за всяка изминала седмица. Числата идват директно от данните; свързващият текст е генериран автоматично."
      />
      {weeks.length === 0 ? (
        <p className="small muted">Все още няма публикувани седмични обзори.</p>
      ) : (
        <DataTable
          columns={columns}
          rows={weeks}
          getKey={(w) => w.iso}
          caption="Седмични обзори"
          rowLink
        />
      )}
    </main>
  );
}
