import { Link } from 'react-router';
import type { ConflictLink } from '@sigma/api-contract';
import { groupByPerson, officialHref } from '../lib/conflicts';
import { personName } from '../lib/person-name';
import { DataTable } from './DataTable';
import { Chip, Section } from './ui';

export function CompanyDeclarants({ links }: { links: ConflictLink[] }) {
  const groups = groupByPerson(links);
  if (!groups.length) return null;
  return (
    <Section id="declared-people" title="Длъжностни лица с декларирана връзка">
      <DataTable
        columns={[
          {
            key: 'person',
            header: 'Длъжностно лице',
            isTitle: true,
            cell: (person) => (
              <Link to={officialHref(person.officialSlug)}>{personName(person.official)}</Link>
            ),
          },
          {
            key: 'office',
            header: 'Институция и длъжност',
            cell: (person) => (
              <ul className="entity-list">
                {person.declaredInstitutions?.map((office) => (
                  <li key={office.institution}>
                    {office.institution}
                    {office.positions.length > 0 && (
                      <div className="small muted">{office.positions.join('; ')}</div>
                    )}
                    {office.years.length > 0 && (
                      <div className="small muted">{office.years.join(', ')}</div>
                    )}
                  </li>
                ))}
              </ul>
            ),
          },
          {
            key: 'basis',
            header: 'Декларирано участие',
            cell: (person) => (
              <Chip>
                {person.stakeKind === 'mixed'
                  ? 'собствен и свързан дял'
                  : person.stakeKind === 'family'
                    ? 'дял на свързано лице'
                    : person.companies?.every((c) => c.manages && !c.self)
                      ? 'декларирано управление'
                      : 'деклариран собствен дял'}
              </Chip>
            ),
          },
        ]}
        rows={groups}
        getKey={(person) => person.personIdentity ?? person.officialSlug}
      />
    </Section>
  );
}
