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
import { timelineCompanies } from '../lib/person-timeline';
import { PersonActivity } from './PersonActivity';
import { declaredStakeNoun } from '../lib/conflicts';
import { tieColumns, tieRows } from '../lib/entity-tables';
import { personName } from '../lib/person-name';

export function PersonProfile({ profile: p }: { profile: LoadedPersonProfile }) {
  const official = p.links.length > 0;
  const companies = timelineCompanies(p);
  const name = personName(p.name);
  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Начало', to: '/' },
          ...(official ? [{ label: 'Свързани лица', to: '/conflicts' }] : []),
          { label: name },
        ]}
      />
      <main id="main">
        <PageHeader
          title={name}
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
          {official && <a href="#declarations">Всички декларации</a>}
          {p.person && (
            <>
              <a href="#network">Граф</a>
              <a href="#roles">Роли</a>
            </>
          )}
          <a href="#contracts">Договори</a>
        </nav>
        {official && (
          <Section
            id="declared-overview"
            title="Декларирани интереси"
            hint={`Лицето е декларирало ${declaredStakeNoun(p.links)}. Институциите и длъжностите са според съответните декларации.`}
          >
            <FactsList
              label="Декларирани интереси"
              rows={[
                {
                  term: 'Свързани дружества',
                  value: count(new Set(p.links.map((l) => l.eik)).size),
                },
                { term: 'Договори в декларирания период', value: count(p.totals.declaredCount) },
                { term: 'Стойност на тези договори', value: money(p.totals.declaredEur) },
              ]}
            />
            <p className="small muted">
              Сумите са към дружествата, а не личен доход. Деклариран дял на свързано лице се
              показва без името на близкия.{' '}
              <Link to="/conflicts/methodology">Методология и поправки →</Link>
            </p>
          </Section>
        )}
        <PersonTimeline profile={p} companies={companies} />
        {official && (
          <Section
            id="declarations"
            title="Всички декларации"
            hint="Всички налични декларации за лицето. Показани са участията в дружества и организации с обществени поръчки и профил в Сигма. Отчетната година, датата на документа и подаването са различни факти."
          >
            <Declarations declarations={p.declarations} />
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
              hint="Текущи и прекратени роли в дружества и организации с обществени поръчки и профил в Сигма, с датите на вписване и заличаване."
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
        <PersonActivity activity={p.activity} hasDeclarations={official} />
      </main>
    </>
  );
}
