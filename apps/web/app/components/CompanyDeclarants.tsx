import { Link } from 'react-router';
import type { ConflictLink } from '@sigma/api-contract';
import { groupByPerson, officialHref, ownStakeLabels } from '../lib/conflicts';
import { personName } from '../lib/person-name';
import { DataTable } from './DataTable';
import { PublicOffices } from './PublicOffices';
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
            cell: (person) => <PublicOffices filings={person.officeFilings} label={null} />,
          },
          {
            key: 'basis',
            header: 'Декларирано участие',
            cell: (person) =>
              person.stakeKind === 'mixed' ? (
                <Chip>собствен и свързан дял</Chip>
              ) : person.stakeKind === 'family' ? (
                <Chip>дял на свързано лице</Chip>
              ) : person.companies?.every((c) => c.manages && !c.self) ? (
                <Chip>декларирано управление</Chip>
              ) : (
                ownStakeLabels(person.companies).map((label) => <Chip key={label}>{label}</Chip>)
              ),
          },
        ]}
        rows={groups}
        getKey={(person) => person.personIdentity ?? person.officialSlug}
      />
    </Section>
  );
}
