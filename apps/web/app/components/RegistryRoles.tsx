import { Link } from 'react-router';
import type { CompanyRole, PersonRole } from '@sigma/api-contract';
import { count, date } from '@sigma/shared';
import { DataTable, type Column } from './DataTable';
import { ROLE_LABEL } from '../lib/registry-roles';
import { roleRowId } from '../lib/profile-navigation';
import { registryUrl } from './ui';
import { personName } from '../lib/person-name';

// The Trade Register's roles as tables (ADR-0039): a company's management and ownership, and a person's roles
// at companies. Facts as registered, each with the day of the entry that added it and, once it ended, the day
// of the entry that ended it; the register is named as the official source with the day it was read, and what
// is shown is not a certificate.

const since: Column<{ addedOn: string }> = {
  key: 'since',
  header: 'От',
  align: 'num',
  cell: (r) => date(r.addedOn),
};
const until: Column<{ removedOn: string | null; uncertainAfter?: string | null }> = {
  key: 'until',
  header: 'До',
  align: 'num',
  cell: (r) =>
    r.uncertainAfter && !r.removedOn
      ? `Неустановено след ${date(r.uncertainAfter)}`
      : date(r.removedOn),
};
const role: Column<{ role: CompanyRole['role'] }> = {
  key: 'role',
  header: 'Роля',
  cell: (r) => ROLE_LABEL[r.role],
};
const share: Column<{ share: string | null }> = {
  key: 'share',
  header: 'Дял',
  secondary: true,
  cell: (r) =>
    r.share ?? (
      <span className="muted" aria-label="Няма данни за дял">
        —
      </span>
    ),
};
const entry: Column<{ entryNumber: string }> = {
  key: 'entry',
  header: 'Вписване №',
  secondary: true,
  cell: (r) => r.entryNumber,
};

function Holder({ holder }: { holder: CompanyRole['holder'] }) {
  const label = holder.kind === 'person' ? personName(holder.name) : holder.name;
  const name = holder.href ? <Link to={holder.href}>{label}</Link> : label;
  // A company that is not a winner here has no page: its ЕИК and, abroad, its country say who it is.
  const about = [
    holder.kind === 'entity' && !holder.href && holder.eik ? `ЕИК ${holder.eik}` : null,
    holder.kind === 'entity' && holder.country && holder.country !== 'БЪЛГАРИЯ'
      ? holder.country
      : null,
  ].filter(Boolean);
  return (
    <>
      {name}
      {about.length > 0 && <span className="muted"> · {about.join(' · ')}</span>}
    </>
  );
}

const holderColumn: Column<CompanyRole> = {
  key: 'holder',
  header: 'Лице',
  isTitle: true,
  cell: (r) => <Holder holder={r.holder} />,
};

const companyColumn: Column<PersonRole> = {
  key: 'company',
  header: 'Дружество',
  isTitle: true,
  cell: (r) =>
    r.company.href ? <Link to={r.company.href}>{r.company.name}</Link> : r.company.name,
};
const partidaColumn: Column<PersonRole> = {
  key: 'partida',
  header: 'Партида',
  cell: (r) => (
    <>
      <a href={registryUrl(r.company.eik)} target="_blank" rel="noopener noreferrer">
        ЕИК {r.company.eik}
        <span className="sr-only"> (в нов раздел)</span>
      </a>
      <div className="small muted">
        Извлечено на {r.fetchedAt ? date(r.fetchedAt) : 'неизвестна дата'}
      </div>
    </>
  ),
};

/** Standing roles in a table; ended ones visible under it, with the day each ended. */
function StandingAndEnded<
  Row extends { removedOn: string | null; uncertainAfter?: string | null },
>({
  rows,
  columns,
  getKey,
  getRowId,
  caption,
}: {
  rows: Row[];
  columns: Column<Row>[];
  getKey: (r: Row, i: number) => string;
  getRowId?: (r: Row) => string;
  caption: string;
}) {
  const standing = rows.filter((r) => !r.removedOn && !r.uncertainAfter);
  const ended = rows.filter((r) => r.removedOn || r.uncertainAfter);
  // An ended role also says until when: right after the day it began.
  const at = columns.findIndex((c) => c.key === since.key) + 1;
  const endedColumns = [...columns.slice(0, at), until as Column<Row>, ...columns.slice(at)];
  return (
    <>
      {standing.length > 0 ? (
        <DataTable
          columns={columns}
          rows={standing}
          getKey={getKey}
          getRowId={getRowId}
          caption={caption}
        />
      ) : (
        <p className="muted">Няма вписани роли, които да са в сила.</p>
      )}
      {ended.length > 0 && (
        <div className="registry-ended">
          <h3>
            {ended.some((r) => r.uncertainAfter) ? 'История на ролите' : 'Прекратени роли'} (
            {count(ended.length)})
          </h3>
          <DataTable
            columns={endedColumns}
            rows={ended}
            getKey={getKey}
            getRowId={getRowId}
            caption={`${caption} — прекратени`}
          />
        </div>
      )}
    </>
  );
}

/** A company's management and ownership. */
export function CompanyRolesTables({ roles }: { roles: CompanyRole[] }) {
  return (
    <StandingAndEnded
      rows={roles}
      columns={[
        holderColumn,
        role as Column<CompanyRole>,
        share as Column<CompanyRole>,
        since as Column<CompanyRole>,
        entry as Column<CompanyRole>,
      ]}
      getKey={(r) => `${r.holder.name}-${r.role}-${r.entryNumber}`}
      caption="Управление и собственост"
    />
  );
}

/** A person's roles at companies. */
export function PersonRolesTables({ roles }: { roles: PersonRole[] }) {
  return (
    <StandingAndEnded
      rows={roles}
      columns={[
        companyColumn,
        role as Column<PersonRole>,
        share as Column<PersonRole>,
        since as Column<PersonRole>,
        partidaColumn,
      ]}
      getKey={(r) => `${r.company.eik}-${r.role}-${r.entryNumber}`}
      getRowId={roleRowId}
      caption="Роли в дружества"
    />
  );
}

/** Shared attribution for registry data; person profiles date each partida separately. */
export function RegistrySource({ asOf, eik }: { asOf?: string | null; eik?: string | null }) {
  return (
    <p className="small muted mt-s3">
      Официален източник: Агенция по вписванията — ТРРЮЛНЦ.
      {asOf ? ` Данните са извлечени на ${date(asOf)}.` : ''} СИГМА ги структурира и съпоставя с
      други публични данни. Справката има информационен характер и не е удостоверителен документ.{' '}
      {eik && (
        <>
          <a href={registryUrl(eik)} target="_blank" rel="noopener noreferrer">
            Оригинална партида<span className="sr-only"> (в нов раздел)</span>
          </a>
          {' · '}
        </>
      )}
      <Link to="/conflicts/methodology#registry-publication">Методология</Link>
      {' · '}
      <Link to="/conflicts/methodology#contest">Сигнал за неточност</Link>
    </p>
  );
}
