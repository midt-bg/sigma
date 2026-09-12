import { Link } from 'react-router';
import { count, money } from '@sigma/shared';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { Breadcrumbs } from './Breadcrumbs';
import { PageHeader } from './PageHeader';
import { FactsList } from './FactsList';
import { Section } from './ui';
import { TieGraph } from './TieGraph';
import { DataTable } from './DataTable';
import { PersonRolesTables, RegistrySource } from './RegistryRoles';
import { Declarations } from './Declarations';
import { PersonTimeline } from './PersonTimeline';
import { PersonCompanies } from './PersonCompanies';
import { timelineCompanies } from '../lib/person-timeline';
import { PersonActivity } from './PersonActivity';
import { declaredStakeNoun } from '../lib/conflicts';
import { tieColumns, tieRows } from '../lib/entity-tables';

export function PersonProfile({ profile: p }: { profile: LoadedPersonProfile }) {
  const official = p.links.length > 0;
  const companies = timelineCompanies(p);
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
              ? 'Длъжностно лице · декларирани интереси'
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
          {official && <a href="#declared-overview">Декларирани интереси</a>}
          <a href="#timeline">Времева линия</a>
          <a href="#holdings">Дружества и източници</a>
          {official && <a href="#declarations">Всички декларации</a>}
          <a href="#contracts">Договори</a>
          {p.person && (
            <>
              <a href="#network">Граф</a>
              <a href="#roles">Роли</a>
            </>
          )}
        </nav>
        {official && (
          <Section
            id="declared-overview"
            title="Декларирани интереси"
            hint={`Лицето е декларирало ${declaredStakeNoun(p.links)}. Институциите и длъжностите са според съответните декларации.`}
          >
            <div className="person-overview">
              <div>
                <strong>{count(new Set(p.links.map((l) => l.eik)).size)}</strong>
                <span>свързани дружества</span>
              </div>
              <div>
                <strong>{count(p.totals.declaredCount)}</strong>
                <span>договора в декларираните периоди</span>
              </div>
              <div>
                <strong>{money(p.totals.declaredEur)}</strong>
                <span>стойност на тези договори</span>
              </div>
            </div>
            <p className="small muted">
              Сумите са към дружествата, а не личен доход. Деклариран дял на свързано лице се
              показва без името на близкия.{' '}
              <Link to="/conflicts/methodology">Методология и поправки →</Link>
            </p>
          </Section>
        )}
        <PersonTimeline profile={p} companies={companies} />
        <PersonCompanies companies={companies} />
        {official && (
          <Section
            id="declarations"
            title="Всички декларации"
            hint="Наличните документи за лицето, включително декларации без дял в показаните дружества. Отчетната година, датата на документа и подаването са различни факти."
          >
            <details className="person-source-archive">
              <summary>Разгледай всички {count(p.declarations.length)} декларации</summary>
              <Declarations declarations={p.declarations} />
            </details>
          </Section>
        )}
        <PersonActivity activity={p.activity} hasDeclarations={official} />
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
      </main>
    </>
  );
}
