import { useRef, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { count, date, money } from '@sigma/shared';
import type { PersonDeclaration } from '@sigma/api-contract';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import { timelineYears, positiveObservation, type TimelineCompany } from '../lib/person-timeline';
import { declarationRowId, revealProfileTarget } from '../lib/profile-navigation';
import { declarationTypeLabel } from './Declarations';
import { groupDeclaredInstitutions, institutionKey } from '../lib/conflicts';
import { ROLE_LABEL } from '../lib/registry-roles';
import { Section, Explanation, Chip } from './ui';

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
  if (!years.length && !companies.length) return null;
  const first = Date.UTC(years[0] ?? 1970, 0, 1),
    last = Date.UTC((years.at(-1) ?? 1970) + 1, 0, 1),
    span = last - first;
  const x = (day: string) => Math.max(0, Math.min(100, ((Date.parse(day) - first) / span) * 100));
  const yearStyle = (year: number): CSSProperties => ({ left: `${x(`${year}-07-02`)}%` });
  const row = (key: string, label: ReactNode, marks: ReactNode, extra = '') => (
    <div className={`person-time-row ${extra}`} key={key}>
      <div className="person-time-label">{label}</div>
      <div className="person-time-track">{marks}</div>
    </div>
  );
  const declarationLink = (
    d: PersonDeclaration,
    label: ReactNode,
    className?: string,
    style?: CSSProperties,
  ) => (
    <a
      key={d.id}
      href={`#${declarationRowId(d.id)}`}
      className={className}
      style={style}
      aria-label={`${d.year ?? ''} · ${declarationTypeLabel(d)} · ${date(d.declaredOn)}${className?.includes('time-disputed') ? '; разминаване между годишни декларации' : ''}; виж декларацията в таблицата`}
      title={`${declarationTypeLabel(d)} · ${date(d.declaredOn)}${className?.includes('time-disputed') ? ' · разминаване между годишни декларации' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        revealProfileTarget(declarationRowId(d.id));
      }}
    >
      {label}
    </a>
  );
  const documents = (docs: PersonDeclaration[], extra = '', disputedIds: string[] = []) => {
    const byYear = new Map<string, number>();
    const dated = docs.filter((d) => d.year && years.includes(+d.year));
    const marks = dated.map((d) => {
      const offset = byYear.get(d.year!) ?? 0;
      byYear.set(d.year!, offset + 1);
      return declarationLink(
        d,
        null,
        `time-observation ${extra} ${disputedIds.includes(d.id) ? 'time-disputed' : ''}`,
        {
          ...yearStyle(+d.year!),
          top: 10 + offset * 22,
        },
      );
    });
    return (
      <div style={{ minHeight: Math.max(34, ...[...byYear.values()].map((n) => n * 22 + 12)) }}>
        {marks}
      </div>
    );
  };
  const contractHref = (eik: string, year: string | null, basis = 'all', authority?: string) => {
    const q = new URLSearchParams({ company: eik, basis });
    if (year) q.set('year', year);
    if (authority) q.set('authority', authority);
    return `${location.pathname}?${q}#contracts`;
  };
  const institutionProfiles = p.timeline.institutionProfiles ?? [];
  const ownIds = new Set(institutionProfiles.map((i) => i.authorityId).filter(Boolean));
  return (
    <Section
      id="timeline"
      title={hasDeclarations ? 'Институции, участия и договори' : 'Участия и договори'}
      hint={
        hasDeclarations
          ? 'Обща времева ос. Квадратчетата водят към декларациите; числата — към договорите за избраното дружество и година.'
          : 'Вписаните роли и договорите на дружествата на обща времева ос. Числата водят към договорите за избраното дружество и година.'
      }
    >
      <div className="person-time-legend">
        {hasDeclarations && (
          <span>
            <i className="time-symbol observed" /> декларация{' '}
            <Explanation text="Знакът показва посочената в декларацията година. Тя не установява точен мандат или период на собственост. Кликни, за да видиш конкретния документ в таблицата." />
          </span>
        )}
        <span>
          <i className="time-symbol role" /> вписана роля{' '}
          <Explanation text="Период по регистърните вписвания. Отделните отсечки пазят прекъсванията; отвореният край достига до последната успешна справка." />
        </span>
        <span>
          <i className="time-symbol eligible" /> с времево съвпадение
        </span>
        <span>
          <i className="time-symbol context" /> без установено съвпадение
        </span>
      </div>
      {p.timeline.observations.some((o) => o.disputed) && (
        <p className="small muted">
          Квадратче с прекъснат контур: разминаване между декларации за същата година. Подробностите
          и двата източника са посочени при дружеството.
        </p>
      )}
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
          {!!years.length &&
            row(
              'axis',
              <span className="mono">Година</span>,
              years.map((y) => (
                <span key={y} className="person-time-year" style={yearStyle(y)}>
                  {y}
                </span>
              )),
              'time-axis',
            )}
          {groupDeclaredInstitutions(p.declarations).map((institution, i) => {
            const authorityId = institutionProfiles.find(
              (a) => institutionKey(a.institution) === institutionKey(institution.institution),
            )?.authorityId;
            const docs = p.declarations.filter(
              (d) => institutionKey(d.institution) === institutionKey(institution.institution),
            );
            return row(
              `office-${i}`,
              <>
                <strong>
                  {authorityId ? (
                    <Link to={`/authorities/${authorityId.replace(/^auth:/, '')}`}>
                      {institution.institution}
                    </Link>
                  ) : (
                    institution.institution
                  )}
                </strong>
                <small>{institution.positions.join('; ')}</small>
              </>,
              documents(docs),
              'time-institution',
            );
          })}
          {companies.map((c) => {
            const roleKinds = [...new Set(c.roles.map((r) => r.role))];
            const history = c.observations.filter((o) =>
              ['prior', 'disposed', 'unknown'].includes(o.timing),
            );
            const disputed = c.observations.filter((o) => o.disputed || o.timing === 'not_listed');
            return (
              <div className="person-time-company" key={c.eik} id={`company-${c.eik}`}>
                {row(
                  `${c.eik}-heading`,
                  <strong>{c.href ? <Link to={c.href}>{c.name}</Link> : c.name}</strong>,
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
                  const ids = new Set(observations.map((o) => o.declarationId));
                  const docs = p.declarations.filter((d) => ids.has(d.id));
                  const label =
                    scope === 'management'
                      ? 'Декларирано управление'
                      : scope === 'self'
                        ? 'Деклариран собствен дял'
                        : 'Дял на свързано лице';
                  return docs.length
                    ? row(
                        `${c.eik}-${scope}`,
                        label,
                        documents(
                          docs,
                          scope === 'family'
                            ? 'time-family'
                            : scope === 'management'
                              ? 'time-management'
                              : '',
                          observations.filter((o) => o.disputed).map((o) => o.declarationId),
                        ),
                      )
                    : null;
                })}
                {roleKinds.map((kind) =>
                  row(
                    `${c.eik}-${kind}`,
                    ROLE_LABEL[kind],
                    c.roles
                      .filter((r) => r.role === kind)
                      .map((r, i) => {
                        const end = r.removedOn ?? c.asOf?.slice(0, 10);
                        const valid =
                          r.addedOn &&
                          end &&
                          Number.isFinite(Date.parse(r.addedOn)) &&
                          Number.isFinite(Date.parse(end)) &&
                          r.addedOn <= end;
                        const label = `${ROLE_LABEL[kind]} · ${date(r.addedOn)} — ${r.removedOn ? date(r.removedOn) : `вписана към ${date(c.asOf)}`}`;
                        return valid ? (
                          <a
                            key={i}
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
                          <span key={i} className="small muted">
                            Няма установен период
                          </span>
                        );
                      }),
                  ),
                )}
                {!c.roles.length &&
                  c.links.length > 0 &&
                  row(
                    `${c.eik}-no-role`,
                    'Лична роля в ТР',
                    <span className="time-history-note">
                      Не е установена
                      {c.links.every((l) => l.relation === 'related')
                        ? ' — декларираният дял е на друго свързано лице.'
                        : ' за декларатора в наличните регистърни данни.'}
                    </span>,
                  )}
                {disputed.length > 0 &&
                  row(
                    `${c.eik}-disputed`,
                    'Разминаване в декларациите',
                    <div className="time-history-note">
                      За{' '}
                      {[...new Set(disputed.map((o) => o.reportedYear))]
                        .filter(Boolean)
                        .sort()
                        .join(', ')}{' '}
                      г. дялът е посочен в един документ и липсва в друг. Връзката остава видима;
                      времевото съвпадение за тези години изисква отделно основание.{' '}
                      {[...new Set(disputed.map((o) => o.declarationId))].map((id) => {
                        const d = p.declarations.find((d) => d.id === id);
                        return d ? (
                          <span className="history-source" key={id}>
                            {declarationLink(
                              d,
                              `${d.year ?? 'Декларация'} · ${date(d.declaredOn)}`,
                            )}{' '}
                          </span>
                        ) : null;
                      })}
                    </div>,
                  )}
                {history.length > 0 &&
                  row(
                    `${c.eik}-history`,
                    <Chip>исторически данни</Chip>,
                    <div className="time-history-note">
                      <span>
                        Предходно участие / прехвърляне · периодът се установява отделно.{' '}
                      </span>
                      {[...new Set(history.map((o) => o.declarationId))].map((id) => {
                        const d = p.declarations.find((d) => d.id === id);
                        return d ? (
                          <span className="history-source" key={id}>
                            {declarationLink(
                              d,
                              `${d.year ?? 'Декларация'} · ${date(d.declaredOn)}`,
                            )}{' '}
                          </span>
                        ) : null;
                      })}
                    </div>,
                  )}
                {c.contracts.some((r) => r.year) &&
                  row(
                    `${c.eik}-contracts`,
                    'Сключени договори',
                    c.contracts
                      .filter((r) => r.year)
                      .map((r) => {
                        const buyers = (p.timeline.buyers ?? []).filter(
                          (b) => b.eik === c.eik && b.year === r.year,
                        );
                        return (
                          <span
                            key={r.year}
                            className="time-contract-bin"
                            style={yearStyle(+r.year!)}
                          >
                            {r.eligible > 0 && (
                              <Link
                                to={contractHref(c.eik, r.year, 'matched')}
                                className="time-contract eligible"
                                aria-label={`${r.year}: ${r.eligible} договора с времево съвпадение`}
                              >
                                {count(r.eligible)}
                              </Link>
                            )}
                            {r.contracts > r.eligible && (
                              <Link
                                to={contractHref(c.eik, r.year, 'context')}
                                className="time-contract context"
                                aria-label={`${r.year}: ${r.contracts - r.eligible} договора без установено съвпадение`}
                              >
                                {count(r.contracts - r.eligible)}
                              </Link>
                            )}
                            {buyers.length > 0 && (
                              <Explanation
                                label={`Възложители през ${r.year} за ${c.name}`}
                                text={
                                  <>
                                    <strong>
                                      {r.year} · {money(r.valueEur)}
                                    </strong>
                                    <ul className="entity-list">
                                      {buyers.map((b) => (
                                        <li key={b.id}>
                                          <Link
                                            to={contractHref(c.eik, r.year, 'all', b.id)}
                                            onClick={(e) =>
                                              e.currentTarget
                                                .closest<HTMLElement>('[popover]')
                                                ?.hidePopover()
                                            }
                                          >
                                            {b.name}
                                          </Link>{' '}
                                          · {count(b.contracts)}{' '}
                                          {b.contracts === 1 ? 'договор' : 'договора'} ·{' '}
                                          {money(b.valueEur)}
                                          {ownIds.has(b.id) && (
                                            <small>
                                              Институция, посочена в декларациите на лицето
                                            </small>
                                          )}
                                        </li>
                                      ))}
                                    </ul>
                                  </>
                                }
                              />
                            )}
                          </span>
                        );
                      }),
                    'time-contracts',
                  )}
                {c.contracts.some((r) => !r.year) &&
                  row(
                    `${c.eik}-undated`,
                    'Договори без дата',
                    <span className="time-history-note">
                      {count(
                        c.contracts.filter((r) => !r.year).reduce((n, r) => n + r.contracts, 0),
                      )}{' '}
                      — не могат да се поставят на оста
                    </span>,
                  )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="small muted person-time-note">
        Числата са брой договори за годината. Съвпадението е по вписана роля или по деклариран
        период; то не означава личен доход или установено нарушение. Всички договори са достъпни в
        списъка. При липсващи дати не извеждаме период.
      </p>
    </Section>
  );
}
