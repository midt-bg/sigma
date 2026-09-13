import { Link } from 'react-router';
import { declarationRowId } from '../lib/profile-navigation';
import { Chip } from './ui';
import type { PersonDeclaration } from '@sigma/api-contract';
import { date } from '@sigma/shared';
import { DataTable, type Column } from './DataTable';

export function declarationTypeLabel(d: Pick<PersonDeclaration, 'type' | 'template'>): string {
  const names: Record<string, string> = {
    Annual: 'Годишна',
    Annualy: 'Годишна', // spelling used by the source XML
    Yearly: 'Годишна',
    Initial: 'Встъпителна',
    Entry: 'Встъпителна',
    Inaugural: 'Встъпителна',
    Assume: 'Встъпителна',
    Vacate: 'Финална',
    Final: 'Финална',
    Change: 'За промяна',
  };
  const kind = d.type && names[d.type];
  const template =
    d.template === 'assets'
      ? 'част I · имущество'
      : d.template === 'interests'
        ? 'част II · интереси'
        : 'декларация';
  return kind ? `${kind} · ${template}` : template;
}
export function declaredInterestLabel(
  i: NonNullable<PersonDeclaration['interests']>[number],
): string {
  const kind =
    i.kind === 'management'
      ? 'управление'
      : i.kind === 'sole_trader'
        ? 'едноличен търговец'
        : i.kind === 'securities'
          ? 'ценни книжа'
          : i.kind === 'shares'
            ? 'дялово участие'
            : 'участие';
  if (i.timing === 'prior') return `предходно ${kind}`;
  if (i.timing === 'disposed') return 'прехвърлен дял';
  if (i.scope === 'family') return 'дял на свързано лице';
  if (i.kind === 'shares' && i.scope === 'self') return 'собствен дял';
  return `${kind}${i.timing === 'unknown' ? ' · неустановен период' : ''}`;
}
const columns: Column<PersonDeclaration>[] = [
  {
    key: 'source',
    header: 'Декларация',
    isTitle: true,
    cell: (d) => (
      <>
        <a
          href={/^https:\/\//.test(d.url) ? d.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {d.year ? `Година ${d.year}` : 'Отвори декларацията'} ↗
        </a>
        <div className="small muted">{declarationTypeLabel(d)}</div>
        {d.type &&
          ['Initial', 'Entry', 'Inaugural', 'Assume', 'Vacate', 'Final'].includes(d.type) &&
          d.year &&
          d.declaredOn &&
          d.year !== d.declaredOn.slice(0, 4) && (
            <div className="small muted">
              Посочената година се различава от датата на документа.
            </div>
          )}
      </>
    ),
  },
  {
    key: 'submitted',
    header: 'Подадена на',
    cell: (d) => (d.submittedOn ? date(d.submittedOn) : <span className="muted">Няма данни</span>),
  },
  {
    key: 'dated',
    header: 'Дата на документа',
    cell: (d) => (d.declaredOn ? date(d.declaredOn) : <span className="muted">Няма данни</span>),
  },
  {
    key: 'institution',
    header: 'Институция и длъжност',
    cell: (d) => (
      <>
        {d.institution || 'Неустановена институция'}
        {d.position && <div className="small muted">{d.position}</div>}
      </>
    ),
  },
  {
    key: 'companies',
    header: 'Дружества и декларирани роли',
    cell: (d) =>
      d.interests?.length ? (
        <ul className="entity-list">
          {d.interests.map((i, n) => (
            <li key={`${i.eik ?? i.company}-${i.kind}-${i.timing}-${n}`}>
              {i.eik ? <Link to={`/companies/${i.eik}`}>{i.company}</Link> : i.company}
              <div className="small">
                <Chip>{declaredInterestLabel(i)}</Chip>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">Няма извлечени участия в този документ</span>
      ),
  },
];
export function Declarations({
  declarations,
  compact = false,
}: {
  declarations: PersonDeclaration[];
  compact?: boolean;
}) {
  if (!declarations.length)
    return <p className="muted">Няма налични документи в заредения набор.</p>;
  return (
    <div className={compact ? 'declarations compact' : 'declarations'}>
      <DataTable
        columns={columns}
        rows={declarations}
        getKey={(d) => d.id}
        getRowId={compact ? undefined : (d) => declarationRowId(d.id)}
        caption="Налични декларации и източници"
      />
    </div>
  );
}
