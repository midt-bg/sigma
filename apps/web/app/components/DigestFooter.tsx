import { Link } from 'react-router';
import { date } from '@sigma/shared';
import { DATA_SOURCE_LICENSE } from '../lib/dataSource';

// Provenance footer for an auto-generated digest (spec §3.11 / §10.4): source license, the data
// freshness the numbers reflect, an explicit „генерирано автоматично", the „коригирано" note when a
// settled week was re-issued with late data, and a link back to the archive. Distinct from the
// site-wide SiteFooter because the digest must state, on the artifact itself, that it was produced
// without a human in the loop.
export function DigestFooter({
  asOf,
  generatedAt,
  refreshedAt,
}: {
  asOf?: string | null;
  generatedAt?: string | null;
  refreshedAt?: string | null;
}) {
  // No role="contentinfo" — the page's SiteFooter already owns that landmark; a second one degrades AT
  // landmark navigation. This is an in-`<main>` provenance note, not the page footer.
  return (
    <footer className="digest-footer">
      <p className="small muted">
        {DATA_SOURCE_LICENSE}
        {asOf ? ` · данни към ${date(asOf)}` : ''}
        {' · генерирано автоматично'}
        {/* Chronological: the original publish date first, then the later correction date. */}
        {generatedAt ? ` · публикувано ${date(generatedAt)}` : ''}
        {refreshedAt ? ` · коригирано на ${date(refreshedAt)}` : ''}
      </p>
      <p className="small muted">
        <Link to="/weeks">← Всички седмични обзори</Link>
      </p>
    </footer>
  );
}
