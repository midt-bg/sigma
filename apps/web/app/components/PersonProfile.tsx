import { Link, useLocation } from 'react-router';
import { count, money } from '@sigma/shared';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { Breadcrumbs } from './Breadcrumbs';
import { PageHeader } from './PageHeader';
import { FactsList } from './FactsList';
import { Section, Callout } from './ui';
import { TieGraph } from './TieGraph';
import { DataTable } from './DataTable';
import { PersonRolesTables, RegistrySource } from './RegistryRoles';
import { Declarations } from './Declarations';
import { DeclaredInstitutions } from './DeclaredInstitutions';
import { ConflictDetail } from './ConflictDetail';
import { PersonActivity } from './PersonActivity';
import { officialRole, declaredStakeNoun, groupDeclaredInstitutions } from '../lib/conflicts';
import { tieColumns, tieRows } from '../lib/entity-tables';

export function PersonProfile({ profile: p }: { profile: LoadedPersonProfile }) {
  const official = p.links.length > 0;
  const multipleInstitutions = groupDeclaredInstitutions(p.declarations).length > 1;
  const location = useLocation();
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          ...(official ? [{ label: 'Свързани лица', to: '/conflicts' }] : []),
          { label: p.name },
        ]}
      />
      <main id="main">
        <PageHeader
          title={p.name}
          kicker={
            official
              ? officialRole(p.links[0]!) || 'Длъжностно лице'
              : p.person
                ? 'Лице · Търговски регистър'
                : 'Длъжностно лице'
          }
          lede={
            official
              ? 'Декларирани интереси и обществени поръчки на свързаните дружества. Декларациите и регистърните роли са отделни източници — деклариран интерес не означава установено нарушение.'
              : 'Роли в дружества и обществените поръчки, спечелени от тях, по данни от Търговския регистър и ЦАИС ЕОП.'
          }
        />
        <nav className="profile-nav" aria-label="В профила">
          {official && (
            <>
              <a href="#declared-overview">Декларирани интереси</a>
              {multipleInstitutions && <a href="#institutions">Институции и длъжности</a>}
              <a href="#declarations">Декларации</a>
            </>
          )}
          {p.person && (
            <>
              <a href="#network">Граф</a>
              <a href="#roles">Роли</a>
            </>
          )}
          <a href="#contracts">Договори</a>
          <a href="#contract-authorities">Възложители</a>
        </nav>
        {official && (
          <>
            <Section
              id="declared-overview"
              title="Декларирани интереси"
              hint={`Лицето е декларирало ${declaredStakeNoun(p.links)}. Институцията и длъжността са според съответната декларация.`}
            >
              <Callout titleAs="h3" title="Източник и обхват">
                <p>
                  Показваме деклариран дял — собствен или на свързано лице; името на близкия не се
                  показва и видът на връзката не се твърди. Всяка връзка има източници.{' '}
                  <Link to="/conflicts/methodology#contest">Методология и поправки →</Link>
                </p>
              </Callout>
              <FactsList
                label="Показатели в декларирания период"
                rows={[
                  { term: 'Договори в декларирания период', value: count(p.totals.declaredCount) },
                  {
                    term: 'Стойност в декларирания период',
                    value: money(p.totals.declaredEur),
                    sub: 'Стойност на договорите на дружествата, а не личен доход.',
                  },
                ]}
              />
            </Section>
            <DeclaredInstitutions declarations={p.declarations} />
            <Section
              id="declarations"
              title="Декларации"
              hint="Всички налични декларации за лицето в заредения набор. Отчетната година, датата на документа и подаването са различни факти."
            >
              <Declarations declarations={p.declarations} />
            </Section>
            <Section
              id="holdings"
              title="Декларирани връзки и периоди"
              hint="Източници и договори за всяко дружество."
            >
              <ConflictDetail
                links={p.links}
                contracts={p.contracts}
                perspective="official"
                contractListHref={location.pathname}
              />
            </Section>
            <PersonActivity activity={p.activity} hasDeclarations />
          </>
        )}
        {p.person && (
          <Section
            id="registry-overview"
            title="Лични роли в Търговския регистър"
            hint="Договори, сключени през вписаните роли на лицето, независимо от текущите филтри."
          >
            <FactsList
              label="Общи показатели"
              rows={[
                { term: 'Дружества с договори', value: count(p.totals.companies) },
                { term: 'Договори', value: count(p.totals.contracts) },
                {
                  term: 'Стойност на договорите',
                  value: money(p.totals.valueEur),
                  sub: 'Само договори, подписани през вписана роля на лицето в съответното дружество.',
                },
              ]}
            />
          </Section>
        )}
        {p.person && (
          <>
            {p.tieLayout && (
              <Section
                id="network"
                title="Връзки с дружества"
                hint="Вписани роли по Търговския регистър."
              >
                <TieGraph layout={p.tieLayout} />
                <div className="sr-only">
                  <DataTable
                    columns={tieColumns}
                    rows={tieRows(p.person.network)}
                    getKey={(r) => `${r.from}-${r.to}-${r.kind}`}
                    caption="Дружества на лицето"
                  />
                </div>
                {p.person.network.omitted > 0 && (
                  <p className="small muted">
                    Още {count(p.person.network.omitted)} дружества са извън схемата; ролите и
                    договорите включват целия наличен набор.
                  </p>
                )}
              </Section>
            )}
            <Section
              id="roles"
              title="Роли"
              hint="Текущи и прекратени роли с датите на вписване и заличаване."
            >
              <PersonRolesTables roles={p.person.roles} />
              <RegistrySource asOf={p.person.asOf} />
            </Section>
          </>
        )}
        {official && !p.person && (
          <p className="small muted profile-registry-note">
            Няма потвърдено съпоставяне с регистърен профил на това лице. Декларираните връзки са
            показани със собствените си източници.{' '}
            <Link to="/conflicts/methodology">Методология →</Link>
          </p>
        )}
        {!official && <PersonActivity activity={p.activity} hasDeclarations={false} />}
      </main>
    </>
  );
}
