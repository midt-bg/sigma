import { Link, useLocation } from 'react-router';
import { count, date, plural } from '@sigma/shared';
import type { TimelineCompany } from '../lib/person-timeline';
import { positiveObservation } from '../lib/person-timeline';
import { Section, RegistryCta } from './ui';
import { Declarations } from './Declarations';

export function PersonCompanies({ companies }: { companies: TimelineCompany[] }) {
  const location = useLocation();
  return (
    <Section
      id="holdings"
      title="Свързани дружества и източници"
      hint={
        companies.some((c) => c.links.length)
          ? 'Всяко дружество е показано веднъж, с отделни основания за връзката и всички налични декларации към него.'
          : 'Дружества с вписана роля на лицето, техните договори и регистърните източници.'
      }
    >
      <div className="person-companies">
        {companies.map((c) => {
          const self = c.links.some((l) => l.relation !== 'related'),
            family = c.links.some((l) => l.relation === 'related');
          const history = c.observations.filter((o) => !positiveObservation(o));
          const sources = [
            ...new Map(history.map((o) => [`${o.declarationId}|${o.timing}`, o])).values(),
          ];
          return (
            <article className="person-company" key={c.eik} id={`company-${c.eik}`}>
              <div className="person-company-heading">
                <h3>{c.href ? <Link to={c.href}>{c.name}</Link> : c.name}</h3>
                <span className="mono small muted">ЕИК {c.eik}</span>
              </div>
              <p className="person-company-basis">
                {[
                  self ? 'Деклариран собствен дял' : null,
                  family ? 'Деклариран дял на свързано лице' : null,
                  c.roles.length ? 'Лична роля в Търговския регистър' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="person-company-links">
                <Link to={`${location.pathname}?company=${c.eik}&basis=all#contracts`}>
                  {count(c.contracts.reduce((n, r) => n + r.eligible, 0))}{' '}
                  {plural(
                    c.contracts.reduce((n, r) => n + r.eligible, 0),
                    'договор',
                    'договора',
                  )}{' '}
                  с времево съвпадение ↓
                </Link>
                <RegistryCta eik={c.eik} />
              </div>
              {sources.length > 0 && (
                <div className="person-history">
                  <strong>Исторически данни</strong>
                  <ul>
                    {sources.map((o) => {
                      const doc = c.declarations.find((d) => d.id === o.declarationId);
                      return (
                        <li key={`${o.declarationId}-${o.timing}`}>
                          {o.timing === 'disposed'
                            ? 'Декларирано прехвърляне'
                            : 'Декларирано предходно участие'}
                          {o.reportedYear ? ` · посочена година ${o.reportedYear}` : ''}
                          {doc?.declaredOn ? ` · документ от ${date(doc.declaredOn)}` : ''}.{' '}
                          {doc && (
                            <a href={doc.url} target="_blank" rel="noopener noreferrer">
                              Декларация ↗
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="small muted">
                    Това е доказателство за историческа връзка. Посочената година не установява сама
                    по себе си начало и край на участието.
                  </p>
                </div>
              )}
              {c.declarations.length > 0 && (
                <details className="person-company-sources">
                  <summary>
                    Декларации и подробности за източниците ({count(c.declarations.length)})
                  </summary>
                  <Declarations declarations={c.declarations} compact />
                </details>
              )}
            </article>
          );
        })}
      </div>
    </Section>
  );
}
