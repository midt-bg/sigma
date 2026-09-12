import { Form, Link, useLocation } from 'react-router';
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
  { key: 'authority', header: 'Възложител', cell: (r) => r.authority },
  { key: 'date', header: 'Сключен на', cell: (r) => date(r.signedAt) },
  { key: 'value', header: 'Стойност', align: 'money', cell: (r) => money(r.valueEur) },
  {
    key: 'period',
    header: 'Основание за връзката',
    cell: (r) => (
      <>
        {r.duringRole && <Chip>лична роля в ТР</Chip>}
        {(r.declarationBasis & 1) !== 0 && <Chip tone="window">деклариран собствен дял</Chip>}
        {(r.declarationBasis & 2) !== 0 && <Chip tone="window">дял на свързано лице</Chip>}
        {!r.signedAt ? (
          'Без дата'
        ) : !r.duringRole && !r.duringDeclaration ? (
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
  const pageHref = (page: number) => {
    const q = new URLSearchParams(location.search);
    q.set('page', String(page));
    return `${location.pathname}?${q}#contracts`;
  };
  return (
    <>
      <Section
        id="contracts"
        title="Договори по свързаните дружества"
        hint={
          hasDeclarations
            ? 'Един общ списък за всички дружества. Договорът е включен, ако е подписан през лична роля в ТР или в декларирания период на собствен дял или дял на свързано лице. Декларациите дават съпоставка по години, а не точни дати на притежание. Основанието е посочено на всеки ред; договорът се брои веднъж.'
            : 'Само договори, подписани през вписана лична роля в съответното дружество. Един договор се брои веднъж, дори при няколко едновременни роли.'
        }
      >
        <Form method="get" action={`${location.pathname}#contracts`} className="profile-filters">
          <label>
            Дружество
            <select
              name="company"
              defaultValue={a.filters.company}
              key={`company-${a.filters.company}`}
            >
              <option value="">Всички</option>
              {a.companies.map((c) => (
                <option key={c.eik} value={c.eik}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Възложител
            <select
              name="authority"
              defaultValue={a.filters.authority}
              key={`authority-${a.filters.authority}`}
            >
              <option value="">Всички</option>
              {a.authorities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Година
            <input
              type="number"
              min="1900"
              max="2200"
              name="year"
              defaultValue={a.filters.year}
              key={`year-${a.filters.year}`}
              placeholder="Всички"
            />
          </label>
          {hasDeclarations && (
            <label>
              Основание
              <select name="basis" defaultValue={a.filters.basis} key={`basis-${a.filters.basis}`}>
                <option value="all">Всички основания</option>
                <option value="role">Лична роля в ТР</option>
                <option value="declaration">Декларирани дялове — всички</option>
                <option value="self">Деклариран собствен дял</option>
                <option value="family">Дял на свързано лице</option>
              </select>
            </label>
          )}
          <button type="submit">Приложи</button>
          <Link to={`${location.pathname}#contracts`}>Изчисти</Link>
        </Form>
        <div className="profile-summary">
          <span>
            <strong>{count(a.total)}</strong> {a.total === 1 ? 'договор' : 'договора'}
          </span>
          <span>
            <strong>{money(a.valueEur)}</strong> обща стойност
          </span>
          {hasDeclarations && <span>{count(a.declaredCount)} в декларирания период</span>}
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
          Стойностите са на договорите на дружествата, а не лични доходи или извършени плащания.
          Личната роля следва датите на вписване и заличаване. При отворена роля съпоставката е до
          последната успешна справка в регистъра. Декларираният период е между първата и последната
          налична декларация за съответния дял; той не доказва лична регистърна роля. Договорите без
          дата и тези извън приложимите периоди са изключени. Основанията могат да се припокриват,
          затова сборът им не се използва като общ брой.
        </p>
      </Section>
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
    </>
  );
}
