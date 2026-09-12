import type { PersonDeclaration } from '@sigma/api-contract';
import { groupDeclaredInstitutions, type DeclaredInstitution } from '../lib/conflicts';
import { DataTable, type Column } from './DataTable';
import { Section } from './ui';

const columns: Column<DeclaredInstitution>[] = [
  { key: 'institution', header: 'Институция', isTitle: true, cell: (r) => r.institution },
  {
    key: 'positions',
    header: 'Декларирани длъжности',
    cell: (r) => r.positions.join('; ') || 'Няма данни',
  },
  {
    key: 'years',
    header: 'Години в декларациите',
    cell: (r) => r.years.join(', ') || 'Няма посочена година',
  },
];

export function DeclaredInstitutions({ declarations }: { declarations: PersonDeclaration[] }) {
  const rows = groupDeclaredInstitutions(declarations);
  if (rows.length < 2) return null;
  return (
    <Section
      id="institutions"
      title="Институции и длъжности"
      hint="Едно лице, декларирало връзки с различни институции. Годините са според декларациите, а не точни мандати; длъжностите не се твърдят като едновременни или настоящи."
    >
      <DataTable
        columns={columns}
        rows={rows}
        getKey={(r) => r.institution}
        caption="Институции и длъжности в декларациите"
      />
    </Section>
  );
}
