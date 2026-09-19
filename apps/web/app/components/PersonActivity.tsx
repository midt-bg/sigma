import { useEffect, useRef, type ChangeEvent } from 'react';
import { Form, Link, useLocation, useNavigation, useRevalidator, useSubmit } from 'react-router';
import { revealProfileTarget } from '../lib/profile-navigation';
import type { PersonActivity as Activity, PersonContractRow } from '@sigma/db';
import { contractSlug } from '@sigma/db';
import { count, money, date } from '@sigma/shared';
import { Section, Chip } from './ui';
import { DataTable, type Column } from './DataTable';

const columns: Column<PersonContractRow>[] = [
  {
    key: 'subject',
    header: 'Договор',
    isTitle: true,
    cell: (r) => <Link to={`/contracts/${contractSlug(r.id)}`}>{r.subject || 'Договор'}</Link>,
  },
  {
    key: 'company',
    header: 'Изпълнител',
    cell: (r) => <Link to={`/companies/${r.eik}`}>{r.company}</Link>,
  },
  {
    key: 'authority',
    header: 'Възложител',
    cell: (r) => (
      <Link to={`/authorities/${r.authorityId.replace(/^auth:/, '')}`}>{r.authority}</Link>
    ),
  },
  { key: 'date', header: 'Сключен на', cell: (r) => date(r.signedAt) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
  {
    key: 'period',
    header: 'Основание за връзката',
    cell: (r) => (
      <>
        {r.duringOfficeYear && <Chip tone="window">година с данни за длъжността</Chip>}
        {r.duringRole && <Chip>лична роля в ТР</Chip>}
        {(r.declarationBasis & 1) !== 0 && <Chip>деклариран собствен дял</Chip>}
        {(r.declarationBasis & 4) !== 0 && <Chip>декларирано управление</Chip>}
        {(r.declarationBasis & 2) !== 0 && <Chip>дял на свързано лице</Chip>}
        {!r.signedAt ? (
          'Без дата'
        ) : !r.duringRole && !r.duringDeclaration && !r.duringOfficeYear ? (
          <span className="muted">Без установено припокриване</span>
        ) : null}
      </>
    ),
  },
];
export function PersonActivity({
  activity: a,
  hasDeclarations,
}: {
  activity: Activity;
  hasDeclarations: boolean;
}) {
  const location = useLocation();
  const selectedProfile = new URLSearchParams(location.search).get('view') === 'profile';
  const submit = useSubmit();
  const navigation = useNavigation();
  const { revalidate, state } = useRevalidator();
  const refreshRequested = useRef(false);
  const stale = !Array.isArray(a.yearOptions) || !a.filterCounts;
  const filterValue = (name: keyof Activity['filters']) =>
    navigation.formData?.get(name)?.toString() ?? a.filters[name];
  const applyFilters = (event: ChangeEvent<HTMLSelectElement>) => {
    void submit(event.currentTarget.form, { action: location.pathname, preventScrollReset: true });
  };
  const optionCount = (name: keyof Activity['filterCounts'], value: string) =>
    navigation.state !== 'idle' && navigation.formData
      ? ' (…)'
      : ` (${count(a.filterCounts[name][value] ?? 0)})`;
  useEffect(() => {
    if (!stale) refreshRequested.current = false;
    else if (!refreshRequested.current) {
      // HMR can keep an older loader payload after the client gains a new field.
      refreshRequested.current = true;
      void revalidate();
    }
  }, [stale, revalidate]);
  useEffect(() => {
    if (!stale && location.hash === '#contract-filters') revealProfileTarget('contract-filters');
  }, [location.key, location.hash, stale]);
  if (stale) {
    return (
      <Section id="contracts" title="Договори по свързаните дружества">
        <p role="status">
          {state === 'loading'
            ? 'Обновяване на договорите…'
            : 'Данните за договорите се нуждаят от обновяване.'}{' '}
          <a href={`${location.pathname}${location.search}#contract-filters`}>Презареди</a>
        </p>
      </Section>
    );
  }
  const pageHref = (page: number) => {
    const q = new URLSearchParams(location.search);
    q.set('page', String(page));
    return `${location.pathname}?${q}#contracts`;
  };
  return (
    <>
      {a.total > 0 && (
        <div className="two-col">
          <Section
            id="contract-years"
            title="По години"
            hint="За всички договори, отговарящи на избраните условия."
          >
            <DataTable
              columns={[
                { key: 'year', header: 'Година', cell: (r) => r.year },
                { key: 'count', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
                {
                  key: 'value',
                  header: 'Стойност',
                  align: 'money',
                  cell: (r) => money(r.valueEur),
                },
              ]}
              rows={a.years}
              getKey={(r) => r.year}
            />
          </Section>
          <Section
            id="contract-authorities"
            title="По възложители"
            hint="За всички договори, отговарящи на избраните условия."
          >
            <DataTable
              columns={[
                {
                  key: 'name',
                  header: 'Възложител',
                  isTitle: true,
                  cell: (r) => (
                    <Link to={`/authorities/${r.id.replace(/^auth:/, '')}`}>{r.name}</Link>
                  ),
                },
                { key: 'count', header: 'Договори', align: 'num', cell: (r) => count(r.contracts) },
                {
                  key: 'value',
                  header: 'Стойност',
                  align: 'money',
                  cell: (r) => money(r.valueEur),
                },
              ]}
              rows={a.byAuthority}
              getKey={(r) => r.id}
            />
          </Section>
        </div>
      )}
      <Section
        id="contracts"
        title="Договори по свързаните дружества"
        hint={
          hasDeclarations
            ? 'Всички налични договори на свързаните дружества. Филтрирай по години с данни за длъжността, деклариран дял или вписана лична роля. Всеки договор се брои веднъж; времевото основание е означено в реда.'
            : 'Всички налични договори на свързаните дружества. Филтрирай по година, възложител или вписана лична роля. Всеки договор се брои веднъж.'
        }
      >
        <Form
          method="get"
          action={location.pathname}
          preventScrollReset
          className="profile-filters"
          id="contract-filters"
          aria-label="Филтри за договорите"
          tabIndex={-1}
        >
          {selectedProfile && <input type="hidden" name="view" value="profile" />}
          <label>
            Дружество
            <select name="company" value={filterValue('company')} onChange={applyFilters}>
              <option value="">Всички{optionCount('company', '')}</option>
              {a.companies.map((c) => (
                <option key={c.eik} value={c.eik}>
                  {c.name}
                  {optionCount('company', c.eik)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Възложител
            <select name="authority" value={filterValue('authority')} onChange={applyFilters}>
              <option value="">Всички{optionCount('authority', '')}</option>
              {a.authorities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {optionCount('authority', c.id)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Година
            <select name="year" value={filterValue('year')} onChange={applyFilters}>
              <option value="">Всички{optionCount('year', '')}</option>
              {a.yearOptions.map((year) => (
                <option key={year} value={year}>
                  {year}
                  {optionCount('year', year)}
                </option>
              ))}
            </select>
          </label>
          {
            <label>
              Период
              <select name="basis" value={filterValue('basis')} onChange={applyFilters}>
                <option value="all">Всички договори{optionCount('basis', 'all')}</option>
                {hasDeclarations && (
                  <>
                    <option value="tied">
                      По време на връзката с дружеството{optionCount('basis', 'tied')}
                    </option>
                    <option value="untied">
                      Извън времето на връзката{optionCount('basis', 'untied')}
                    </option>
                  </>
                )}
                <option value="role">Лична роля в ТР{optionCount('basis', 'role')}</option>
                <option value="declaration" disabled={!hasDeclarations}>
                  Само в декларирания период{optionCount('basis', 'declaration')}
                </option>
                <option value="self" disabled={!hasDeclarations}>
                  Деклариран собствен дял или управление{optionCount('basis', 'self')}
                </option>
                <option value="family" disabled={!hasDeclarations}>
                  Дял на свързано лице{optionCount('basis', 'family')}
                </option>
              </select>
            </label>
          }
          <div className="profile-filter-actions">
            <noscript>
              <button type="submit">Приложи</button>
            </noscript>
            <Link
              className="filter-reset"
              to={`${location.pathname}${selectedProfile ? '?view=profile' : ''}`}
              preventScrollReset
            >
              Изчисти
            </Link>
          </div>
        </Form>
        <div className="profile-summary">
          <span>
            <strong>{count(a.total)}</strong> {a.total === 1 ? 'договор' : 'договора'}
          </span>
          <span>
            <strong>{money(a.valueEur)}</strong> обща стойност
          </span>
          {hasDeclarations && (
            <span>
              {count(a.declaredCount)} в декларирания период · {money(a.declaredEur)}
            </span>
          )}
          <span>
            {count(a.roleCount)} през вписана роля · {money(a.roleEur)}
          </span>
        </div>
        {a.contracts.length ? (
          <DataTable
            columns={columns}
            rows={a.contracts}
            getKey={(r) => r.id}
            caption="Договори на свързаните дружества"
          />
        ) : (
          <p className="muted">
            Няма договори за избраното основание и условия.
            {hasDeclarations &&
              a.filters.basis === 'role' &&
              ' Деклариран дял на свързано лице не означава лична роля в Търговския регистър.'}
          </p>
        )}
        {a.total > a.pageSize && (
          <nav className="profile-pagination" aria-label="Страници с договори">
            {a.page > 1 && <Link to={pageHref(a.page - 1)}>← Предишна</Link>}
            <span>
              Страница {a.page} от {Math.ceil(a.total / a.pageSize)}
            </span>
            {a.page * a.pageSize < a.total && <Link to={pageHref(a.page + 1)}>Следваща →</Link>}
          </nav>
        )}
        <p className="small muted profile-period-note">
          Стойностите са на договорите на дружествата, а не лични доходи или извършени плащания.{' '}
          {hasDeclarations &&
            'Времето на връзката е периодът, в който регистърът вписва ролята на лицето в същото дружество или декларацията му обхваща годината; то е за всяко дружество поотделно и не установява точните дати на мандата. '}
          Личната роля следва датите на вписване и заличаване. При отворена роля съпоставката е до
          последната успешна справка в регистъра.{' '}
          {hasDeclarations &&
            'Декларираният период е между първата и последната налична декларация за съответния дял; той не доказва лична регистърна роля. '}
          При началния избор са включени и договорите без дата или без установено времево
          съвпадение. Основанията могат да се припокриват, затова сборът им не се използва като общ
          брой.
        </p>
      </Section>
    </>
  );
}
