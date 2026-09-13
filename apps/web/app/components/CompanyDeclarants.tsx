import { Link } from 'react-router';
import type { ConflictLink } from '@sigma/api-contract';
import { companyDeclarantGroups } from '../lib/company-declarants';
import { officialHref } from '../lib/conflicts';
import { personName } from '../lib/person-name';
import { DataTable } from './DataTable';
import { Chip, Section } from './ui';

export function CompanyDeclarants({ links }: { links: ConflictLink[] }) {
  const groups = companyDeclarantGroups(links);
  if (!groups.length) return null;
  return (
    <Section id="declared-people" title="Длъжностни лица с декларирана връзка">
      <DataTable
        columns={[
          {
            key: 'person',
            header: 'Длъжностно лице',
            isTitle: true,
            cell: (profiles) =>
              profiles.length === 1 ? (
                <Link to={officialHref(profiles[0]!.officialSlug)}>
                  {personName(profiles[0]!.official)}
                </Link>
              ) : (
                personName(profiles[0]!.official)
              ),
          },
          {
            key: 'office',
            header: 'Институция и длъжност',
            cell: (profiles) => (
              <ul className="entity-list">
                {profiles.flatMap((profile) =>
                  profile.declaredInstitutions?.map((office, index, offices) => (
                    <li key={`${profile.officialSlug}:${office.institution}`}>
                      {office.institution}
                      {office.positions.length > 0 && (
                        <div className="small muted">{office.positions.join('; ')}</div>
                      )}
                      {office.years.length > 0 && (
                        <div className="small muted">{office.years.join(', ')}</div>
                      )}
                      {profiles.length > 1 && index === offices.length - 1 && (
                        <Link className="small" to={officialHref(profile.officialSlug)}>
                          Профил и декларации →
                        </Link>
                      )}
                    </li>
                  )),
                )}
              </ul>
            ),
          },
          {
            key: 'basis',
            header: 'Декларирано участие',
            cell: (profiles) => {
              const kinds = new Set(profiles.map((p) => p.stakeKind));
              return (
                <Chip>
                  {kinds.size > 1 || kinds.has('mixed')
                    ? 'собствен и свързан дял'
                    : kinds.has('family')
                      ? 'дял на свързано лице'
                      : 'деклариран собствен дял'}
                </Chip>
              );
            },
          },
        ]}
        rows={groups}
        getKey={(profiles) => profiles[0]!.personIdentity ?? profiles[0]!.officialSlug}
      />
    </Section>
  );
}
