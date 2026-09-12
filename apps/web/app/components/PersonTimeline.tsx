import { useRef, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { count, date } from '@sigma/shared';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { timelineYears, positiveObservation, type TimelineCompany } from '../lib/person-timeline';
import { groupDeclaredInstitutions } from '../lib/conflicts';
import { ROLE_LABEL } from '../lib/registry-roles';
import { Section } from './ui';

export function PersonTimeline({
  profile: p,
  companies,
}: {
  profile: LoadedPersonProfile;
  companies: TimelineCompany[];
}) {
  const location = useLocation();
  const years = timelineYears(p, companies);
  const scroll = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const hasDeclarations = p.declarations.length > 0;
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const update = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
    update();
    el.scrollLeft = el.scrollWidth;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [p.name, years.length]);
  if (!years.length) return null;
  const first = Date.UTC(years[0]!, 0, 1),
    last = Date.UTC(years.at(-1)! + 1, 0, 1),
    span = last - first;
  const x = (day: string) => Math.max(0, Math.min(100, ((Date.parse(day) - first) / span) * 100));
  const yearStyle = (year: number): CSSProperties => ({ left: `${x(`${year}-07-02`)}%` });
  const row = (key: string, label: ReactNode, marks: ReactNode, extra = '') => (
    <div className={`person-time-row ${extra}`} key={key}>
      <div className="person-time-label">{label}</div>
      <div className="person-time-track">{marks}</div>
    </div>
  );
  return (
    <Section
      id="timeline"
      title={hasDeclarations ? 'Институции, участия и договори' : 'Участия и договори'}
      hint={
        hasDeclarations
          ? 'Една времева ос за източниците. Декларациите отбелязват години; плътните линии показват точните вписани периоди в Търговския регистър.'
          : 'Вписаните роли и договорите на дружествата на една времева ос. Плътните линии показват периодите по Търговския регистър.'
      }
    >
      <div className="person-time-legend">
        {hasDeclarations && (
          <span>
            <i className="time-symbol observed" /> година в декларация
          </span>
        )}
        <span>
          <i className="time-symbol role" /> вписана роля
        </span>
        <span>
          <i className="time-symbol eligible" /> договори с времево съвпадение
        </span>
        <span>
          <i className="time-symbol context" /> останали договори на дружеството
        </span>
      </div>
      {scrollable && (
        <div className="person-time-controls">
          <span>
            {years[0]}–{years.at(-1)}
          </span>
          <button
            type="button"
            aria-controls="person-time-canvas"
            onClick={() =>
              scroll.current?.scrollBy({ left: -Math.max(180, scroll.current.clientWidth - 190) })
            }
          >
            ← По-рано
          </button>
          <button
            type="button"
            aria-controls="person-time-canvas"
            onClick={() =>
              scroll.current?.scrollBy({ left: Math.max(180, scroll.current.clientWidth - 190) })
            }
          >
            По-късно →
          </button>
        </div>
      )}
      <div
        ref={scroll}
        id="person-time-canvas"
        className="person-time-scroll"
        role="region"
        aria-label="Обща времева линия, превъртай хоризонтално при нужда"
        tabIndex={0}
      >
        <div className="person-time" style={{ '--timeline-years': years.length } as CSSProperties}>
          {row(
            'axis',
            <span className="mono">Година</span>,
            years.map((y) => (
              <span key={y} className="person-time-year" style={yearStyle(y)}>
                {y}
              </span>
            )),
            'time-axis',
          )}
          {groupDeclaredInstitutions(p.declarations).map((institution, i) =>
            row(
              `office-${i}`,
              <>
                <strong>{institution.institution}</strong>
                <small>{institution.positions.join('; ')}</small>
              </>,
              institution.years.map((y) => (
                <a
                  key={y}
                  className="time-observation"
                  style={yearStyle(+y)}
                  href="#declarations"
                  aria-label={`${institution.institution}, ${y}; виж декларациите`}
                  title={`${institution.institution} · ${y} · година в декларация, не точен мандат`}
                />
              )),
              'time-institution',
            ),
          )}
          {companies.map((c) => (
            <div className="person-time-company" key={c.eik}>
              {row(
                `${c.eik}-heading`,
                <a href={`#company-${c.eik}`}>
                  <strong>{c.name}</strong>
                </a>,
                null,
                'time-company-heading',
              )}
              {(['self', 'family', 'management'] as const).map((scope) => {
                const observations = c.observations.filter(
                  (o) =>
                    positiveObservation(o) &&
                    (scope === 'management'
                      ? o.scope === 'self' && o.kind === 'management'
                      : o.scope === scope &&
                        ['shares', 'participation', 'sole_trader'].includes(o.kind)),
                );
                const observed = [
                  ...new Set(observations.map((o) => o.reportedYear).filter(Boolean)),
                ];
                const label =
                  scope === 'management'
                    ? 'Декларирано управление'
                    : scope === 'self'
                      ? 'Деклариран собствен дял'
                      : 'Дял на свързано лице';
                return observed.length
                  ? row(
                      `${c.eik}-${scope}`,
                      label,
                      observed.map((y) => (
                        <a
                          key={y}
                          className={`time-observation ${scope === 'family' ? 'time-family' : scope === 'management' ? 'time-management' : ''}`}
                          style={yearStyle(+y!)}
                          href={`#company-${c.eik}`}
                          title={`${y} · ${label} · източници`}
                          aria-label={`${label}, деклариран за ${y}`}
                        />
                      )),
                    )
                  : null;
              })}
              {c.roles.map((r, i) => {
                const end = r.removedOn ?? c.asOf?.slice(0, 10);
                const valid =
                  r.addedOn &&
                  end &&
                  Number.isFinite(Date.parse(r.addedOn)) &&
                  Number.isFinite(Date.parse(end)) &&
                  r.addedOn <= end;
                const label = `${ROLE_LABEL[r.role]} · ${date(r.addedOn)} — ${r.removedOn ? date(r.removedOn) : `вписана към ${date(c.asOf)}`}`;
                return row(
                  `${c.eik}-role-${i}`,
                  ROLE_LABEL[r.role],
                  valid ? (
                    <a
                      href="#roles"
                      className={`time-role ${!r.removedOn ? 'time-open' : ''}`}
                      style={{
                        left: `${x(r.addedOn)}%`,
                        width: `${Math.max(0.15, x(end!) - x(r.addedOn))}%`,
                      }}
                      title={label}
                      aria-label={label}
                    />
                  ) : (
                    <span className="small muted">Няма установен период</span>
                  ),
                );
              })}
              {c.observations.some((o) => !positiveObservation(o)) &&
                row(
                  `${c.eik}-history`,
                  'Исторически сведения',
                  <span className="time-history-note">
                    Предходно участие / прехвърляне —{' '}
                    <a href={`#company-${c.eik}`}>виж фактите и датите</a>
                  </span>,
                )}
              {c.contracts.some((r) => r.year) &&
                row(
                  `${c.eik}-contracts`,
                  'Сключени договори',
                  c.contracts
                    .filter((r) => r.year)
                    .map((r) => {
                      const href = `${location.pathname}?company=${c.eik}&year=${r.year}&basis=all#contracts`;
                      const label = `${r.year}: ${r.contracts} договора на дружеството; ${r.eligible} с времево съвпадение`;
                      return (
                        <span
                          key={r.year}
                          className="time-contract-bin"
                          style={yearStyle(+r.year!)}
                        >
                          {r.eligible > 0 ? (
                            <Link
                              to={href}
                              className="time-contract eligible"
                              title={label}
                              aria-label={label}
                            >
                              {count(r.eligible)}
                            </Link>
                          ) : null}
                          {r.contracts > r.eligible ? (
                            <Link
                              to={`/companies/${c.eik}#contracts`}
                              className="time-contract context"
                              title={`${r.year}: ${r.contracts - r.eligible} извън установените периоди; виж всички договори на дружеството`}
                              aria-label={`${r.contracts - r.eligible} договора извън установените периоди през ${r.year}`}
                            >
                              {count(r.contracts - r.eligible)}
                            </Link>
                          ) : null}
                        </span>
                      );
                    }),
                )}
              {c.contracts.some((r) => !r.year) &&
                row(
                  `${c.eik}-undated`,
                  'Договори без дата',
                  <span className="small muted">
                    {count(c.contracts.filter((r) => !r.year).reduce((n, r) => n + r.contracts, 0))}{' '}
                    — не могат да се поставят на оста
                  </span>,
                )}
            </div>
          ))}
        </div>
      </div>
      <p className="small muted person-time-note">
        Числата са брой договори за годината. Съвпадението е по вписана роля или по деклариран
        период; то не означава личен доход или установено нарушение. Сивите договори са само
        контекст и не влизат в списъка на лицето. При липсващи дати не извеждаме период.
      </p>
    </Section>
  );
}
