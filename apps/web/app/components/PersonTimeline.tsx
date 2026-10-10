import {
  Fragment,
  useRef,
  useEffect,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router';
import { count, date, money, pct } from '@sigma/shared';
import type { PersonDeclaration, PersonRole } from '@sigma/api-contract';
import { contractSlug, type TimelineContracts, type TimelineProcurement } from '@sigma/db';
import type { LoadedPersonProfile } from '../lib/person-profile.server';
import {
  timelineYears,
  positiveObservation,
  officeSpans,
  packLanes,
  insideSpans,
  yearSpans,
  type OfficeSpan,
  type TimelineCompany,
} from '../lib/person-timeline';
import { declarationRowId, roleRowId, revealProfileTarget } from '../lib/profile-navigation';
import { declarationTypeLabel } from './Declarations';
import { groupDeclaredInstitutions, institutionKey } from '../lib/conflicts';
import { ROLE_LABEL } from '../lib/registry-roles';
import { publicStakeLabels } from '../lib/public-stake';
import { Section, Explanation } from './ui';

function InstitutionSymbol() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M3 9h18L12 3 3 9Zm2 11h14M3 23h18M6 11v7m6-7v7m6-7v7" />
    </svg>
  );
}

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
  const [tip, setTip] = useState<TimelineTip | null>(null);
  const intervals = p.timelineIntervals ?? null;
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
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, { passive: true });
    return () => window.removeEventListener('scroll', hide);
  }, [tip]);
  if (!years.length && !companies.length) return null;
  const heldSeats = companies.some((c) => c.heldSeat);
  const first = Date.UTC(years[0] ?? 1970, 0, 1),
    last = Date.UTC((years.at(-1) ?? 1970) + 1, 0, 1),
    span = last - first;
  const x = (day: string) => Math.max(0, Math.min(100, ((Date.parse(day) - first) / span) * 100));
  const yearStyle = (year: number): CSSProperties => ({ left: `${x(`${year}-07-02`)}%` });
  const between = (from: string, to: string): CSSProperties => ({
    left: `${x(from)}%`,
    width: `${Math.max(0.15, x(to) - x(from))}%`,
  });
  // One tooltip for the whole axis, placed against the viewport so the scrolling canvas cannot clip it,
  // under the pointer on a long span and under the element on focus. It repeats for the eye what each
  // mark's own label already says to a screen reader; decorative spans are for the pointer only.
  const showTip = (el: Element, content: ReactNode, pointerX?: number) => {
    const box = el.getBoundingClientRect();
    const anchor = pointerX ?? box.left + box.width / 2;
    const left = Math.max(12, Math.min(anchor - 150, window.innerWidth - 312));
    setTip(
      box.bottom + 220 < window.innerHeight
        ? { content, left, top: box.bottom + 8 }
        : { content, left, bottom: window.innerHeight - box.top + 8 },
    );
  };
  const hideTip = () => setTip(null);
  const tipProps = (content: () => ReactNode, focusable = true) => ({
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) =>
      showTip(event.currentTarget, content(), event.clientX),
    onMouseLeave: hideTip,
    ...(focusable
      ? {
          onFocus: (event: ReactFocusEvent<HTMLElement>) => showTip(event.currentTarget, content()),
          onBlur: hideTip,
        }
      : {}),
  });
  // The overlap band sits under every row of its company, so the rows together read as one column.
  const band = (spans: [string, string][] | undefined) =>
    (spans ?? []).map(([from, to]) => (
      <span
        key={`band-${from}`}
        className="time-band"
        style={between(from, to)}
        aria-hidden="true"
        {...tipProps(() => bandTip(from, to), false)}
      />
    ));
  const row = (
    key: string,
    label: ReactNode,
    marks: ReactNode,
    extra = '',
    under?: [string, string][],
  ) => (
    <div className={`person-time-row ${extra}`} key={key}>
      <div className="person-time-label">{label}</div>
      <div className="person-time-track">
        {band(under)}
        {marks}
      </div>
    </div>
  );
  const declarationLink = (
    d: PersonDeclaration,
    label: ReactNode,
    className?: string,
    style?: CSSProperties,
    context?: string,
  ) => {
    const disputed = !!className?.includes('time-disputed');
    return (
      <a
        key={d.id}
        href={`#${declarationRowId(d.id)}`}
        className={className}
        style={style}
        aria-label={`${d.year ?? ''} · ${declarationTypeLabel(d)} · ${date(d.declaredOn)}${disputed ? '; разминаване между годишни декларации' : ''}; виж декларацията в таблицата`}
        {...(label == null
          ? tipProps(() => declarationTip(d, context, disputed))
          : {
              title: `${declarationTypeLabel(d)} · ${date(d.declaredOn)}${disputed ? ' · разминаване между годишни декларации' : ''}`,
            })}
        onClick={(e) => {
          e.preventDefault();
          revealProfileTarget(declarationRowId(d.id));
        }}
      >
        {label}
      </a>
    );
  };
  const documents = (
    docs: PersonDeclaration[],
    extra = '',
    disputedIds: string[] = [],
    context?: string,
  ) => {
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
        context,
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
    if (new URLSearchParams(location.search).get('view') === 'profile') q.set('view', 'profile');
    if (year) q.set('year', year);
    if (authority) q.set('authority', authority);
    return `${location.pathname}?${q}#contract-filters`;
  };
  // An office drawn as its years, solid where the declarations anchor it, faded where not.
  const officeBars = (docs: PersonDeclaration[], institution: string, positions: string[]) =>
    officeSpans(docs).map((o) => {
      const s = x(o.from),
        w = Math.max(0.15, x(o.to) - s);
      const first = o.from.slice(0, 4),
        last = o.to.slice(0, 4);
      const a = ((x(o.knownStart ?? `${first}-12-31`) - s) / w) * 100;
      const b = o.knownEnd ? 100 : ((x(`${last}-01-01`) - s) / w) * 100;
      const label = `Длъжност ${first}${first === last ? '' : `–${last}`}: ${
        o.knownStart ? `встъпителна декларация ${date(o.knownStart)}` : 'началото не е известно'
      }; ${o.knownEnd ? `финална декларация ${date(o.knownEnd)}` : 'краят не е известен'}`;
      return (
        <span
          key={o.from}
          role="img"
          className={`time-office ${a > b ? 'time-office-faded' : ''}`}
          style={{
            left: `${s}%`,
            width: `${w}%`,
            ...(a > b
              ? {}
              : {
                  background: `linear-gradient(to right, var(--office-faded) 0%, var(--office) ${a}%, var(--office) ${b}%, var(--office-faded) 100%)`,
                }),
          }}
          aria-label={label}
          {...tipProps(() => officeTip(institution, positions, o), false)}
        />
      );
    });
  const institutionProfiles = p.timeline.institutionProfiles ?? [];
  const ownIds = new Set(institutionProfiles.map((i) => i.authorityId).filter(Boolean));
  const procurementMark = (pr: TimelineProcurement, under: [string, string][] | undefined) => {
    const kind: ProcurementKind = pr.tied
      ? 'tied'
      : insideSpans(under, pr.announcedAt)
        ? 'announced'
        : 'context';
    // The buyer is one of the institutions in the person's own declarations: the same test, and the same
    // building mark, as the year bins and the legend use.
    const own = ownIds.has(pr.authorityId);
    const label = [
      pr.subject || 'Договор',
      pr.authority,
      own ? 'възложител от институциите в декларациите' : null,
      pr.announcedAt ? `обявена ${date(pr.announcedAt)}` : 'без дата на обявяване',
      `подписан ${date(pr.signedAt)}`,
      pr.valueEur != null ? money(pr.valueEur) : null,
      kind === 'tied'
        ? 'подписан по време на съвпадението'
        : kind === 'announced'
          ? 'обявена по време на съвпадението, подписана извън него'
          : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <Link
        key={pr.id}
        to={`/contracts/${contractSlug(pr.id)}`}
        className={`time-procurement ${kind} ${own ? 'own' : ''} ${pr.announcedAt ? '' : 'time-undated-start'}`}
        style={between(pr.announcedAt ?? pr.signedAt, pr.signedAt)}
        aria-label={label}
        {...tipProps(() => procurementTip(pr, kind, own))}
      >
        {own && <InstitutionSymbol />}
      </Link>
    );
  };
  const bandMismatch = intervals
    ? intervals.procurements.filter(
        (pr) => pr.tied !== insideSpans(intervals.bands[pr.eik], pr.signedAt),
      ).length
    : undefined;
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
        {heldSeats && (
          <span>
            <i className="time-symbol role-office" /> вписана роля, която е заемана длъжност{' '}
            <Explanation text="Място в органите на публично предприятие, на дружество с публично участие или на организацията, за която лицето подава декларации като член на нейните органи. Периодът е по регистърните вписвания. Мястото е самата длъжност, а не частен интерес: затова под него няма съвпадение, а договорите на организацията не се отнасят към лицето." />
          </span>
        )}
        {hasDeclarations ? (
          <>
            <span>
              <i className="time-symbol eligible" /> по време на връзката, в година с декларация за
              длъжността{' '}
              <Explanation text="Договори, подписани, докато едновременно: регистърът вписва ролята на лицето в същото дружество (или декларацията му обхваща периода) И за годината има декларация за публична длъжност. Длъжността се знае по година; началото и краят ѝ се вземат от датите на встъпителната и финалната декларация, когато ги има. Не твърди участие в конкретната поръчка." />
            </span>
            <span>
              <i className="time-symbol context" /> извън съвпадението
            </span>
          </>
        ) : (
          <span>
            <i className="time-symbol context" /> договори
          </span>
        )}
        {intervals && (
          <>
            <span>
              <i className="time-symbol band" /> съвпадение{' '}
              <Explanation text="Дните, в които подписан договор се брои за съвпадение: лицето е свързано със същото дружество (вписана роля или деклариран дял) и за годината има декларация за публична длъжност. Същото правило като червените числа." />
            </span>
            <span>
              <i className="time-symbol office" /> длъжност{' '}
              <Explanation text="Годините с декларация за институцията. Твърд край — по датата на встъпителната или финалната декларация, която се подава до месец след събитието. Избледнял край — в рамките на годината той не е известен." />
            </span>
            <span>
              <i className="time-symbol procurement" /> поръчка: обявяване → подписване
            </span>
            <span>
              <i className="time-symbol announced" /> обявена по време на съвпадението, подписана
              извън него
            </span>
          </>
        )}
        {(p.timeline.buyers ?? []).some((b) => ownIds.has(b.id)) && (
          <span>
            <InstitutionSymbol /> възложител от институциите в декларациите
          </span>
        )}
      </div>
      {p.timeline.observations.some((o) => o.disputed) && (
        <p className="small muted">
          Квадратче с прекъснат контур: разминаване между декларации за същата година. Подробностите
          и източниците са под името на съответното дружество.
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
        onScroll={hideTip}
      >
        <div
          className="person-time"
          style={{ '--timeline-years': years.length } as CSSProperties}
          data-band-mismatch={bandMismatch}
        >
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
          {(p.declarations.length > 0 || companies.some((c) => c.heldSeat)) && (
            <h3 className="person-time-section">Заемани длъжности</h3>
          )}
          {groupDeclaredInstitutions(p.declarations).map((institution, i) => {
            const authorityId = institutionProfiles.find(
              (a) => institutionKey(a.institution) === institutionKey(institution.institution),
            )?.authorityId;
            const docs = p.declarations.filter(
              (d) => institutionKey(d.institution) === institutionKey(institution.institution),
            );
            // A seat in an organization's bodies is shown under the organization; what the person wrote as
            // their workplace stays beside it, verbatim, earliest first.
            const works = [
              ...new Set(
                [...docs]
                  .sort((a, b) => (a.year ?? '').localeCompare(b.year ?? ''))
                  .map((d) => d.office?.work)
                  .filter((w): w is string => !!w),
              ),
            ];
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
                {docs.some((d) => d.office?.basis === 'category') && (
                  <small>Институция по категорията на декларацията</small>
                )}
                {works.length > 0 && (
                  <small>
                    Месторабота според декларацията:{' '}
                    <span className="verbatim">{works.map((w) => `„${w}“`).join('; ')}</span>
                  </small>
                )}
              </>,
              intervals ? (
                <>
                  {officeBars(docs, institution.institution, institution.positions)}
                  {documents(docs)}
                </>
              ) : (
                documents(docs)
              ),
              'time-institution',
            );
          })}
          {companies.map((c, i) => {
            const heading =
              !c.heldSeat && (i === 0 || companies[i - 1]!.heldSeat) ? (
                <h3 className="person-time-section">Дружества</h3>
              ) : null;
            const roleKinds = [...new Set(c.roles.map((r) => r.role))];
            const noRole = !c.roles.length && c.links.length > 0;
            const history = c.observations.filter((o) =>
              ['prior', 'disposed', 'unknown'].includes(o.timing),
            );
            const disputed = c.observations.filter((o) => o.disputed || o.timing === 'not_listed');
            const undated = c.contracts.filter((r) => !r.year).reduce((n, r) => n + r.contracts, 0);
            // A held seat is the office itself: its overlap with the office years would mark the seat as
            // coinciding with itself. Its contracts are not the person's either (person-activity.ts), so the
            // band would have nothing to mark.
            const under = c.heldSeat ? undefined : intervals?.bands[c.eik];
            const procurements = intervals?.procurements.filter((pr) => pr.eik === c.eik) ?? [];

            return (
              <Fragment key={c.eik}>
                {heading}
                <div className="person-time-company" id={`company-${c.eik}`}>
                  <div className="time-company-heading">
                    <strong>{c.href ? <Link to={c.href}>{c.name}</Link> : c.name}</strong>
                    {c.heldSeat && publicStakeLabels(c.publicStake).length > 0 && (
                      <div className="time-public-stake">
                        {publicStakeLabels(c.publicStake).join(' · ')}
                      </div>
                    )}
                    <div className="person-time-notes">
                      {noRole && (
                        <p>
                          Лична роля в ТР не е установена
                          {c.links.every((l) => l.relation === 'related')
                            ? ' — декларираният дял е на друго свързано лице.'
                            : ' за декларатора в наличните регистърни данни.'}
                        </p>
                      )}
                      {disputed.length > 0 && (
                        <p>
                          <strong>Разминаване в декларациите.</strong> За{' '}
                          {[...new Set(disputed.map((o) => o.reportedYear))]
                            .filter(Boolean)
                            .sort()
                            .join(', ')}{' '}
                          г. дялът е посочен в един документ и липсва в друг. Връзката остава
                          видима; времевото съвпадение за тези години изисква отделно основание.{' '}
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
                        </p>
                      )}
                      {history.length > 0 && (
                        <p>
                          <strong>Исторически данни.</strong> Предходно участие / прехвърляне ·
                          периодът се установява отделно.{' '}
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
                        </p>
                      )}
                      {undated > 0 && (
                        <p>
                          Договори без дата: {count(undated)} — не могат да се поставят на оста.
                        </p>
                      )}
                    </div>
                  </div>
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
                    const declaredYears = (intervals?.declared ?? [])
                      .filter((d) => d.eik === c.eik && d.scope === scope)
                      .map((d) => d.year);
                    return docs.length
                      ? row(
                          `${c.eik}-${scope}`,
                          label,
                          <>
                            {yearSpans(declaredYears).map(([from, to]) => (
                              <span
                                key={`declared-${from}`}
                                className="time-declared"
                                style={between(from, to)}
                                aria-hidden="true"
                                {...tipProps(() => declaredTip(label, c.name, from, to), false)}
                              />
                            ))}
                            {documents(
                              docs,
                              scope === 'family'
                                ? 'time-family'
                                : scope === 'management'
                                  ? 'time-management'
                                  : '',
                              observations.filter((o) => o.disputed).map((o) => o.declarationId),
                              `${label} · ${c.name}`,
                            )}
                          </>,
                          '',
                          under,
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
                          const end = r.removedOn ?? r.uncertainAfter ?? c.asOf?.slice(0, 10);
                          const valid =
                            r.addedOn &&
                            end &&
                            Number.isFinite(Date.parse(r.addedOn)) &&
                            Number.isFinite(Date.parse(end)) &&
                            r.addedOn <= end;
                          const label = `${ROLE_LABEL[kind]} · ${date(r.addedOn)} — ${r.removedOn ? date(r.removedOn) : r.uncertainAfter ? `неустановено след ${date(r.uncertainAfter)}` : `вписана към ${date(c.asOf)}`}${c.heldSeat ? ' · заемана длъжност' : ''}`;
                          return valid ? (
                            <a
                              key={i}
                              href={`#${roleRowId(r)}`}
                              onClick={(event) => {
                                if (
                                  event.button !== 0 ||
                                  event.metaKey ||
                                  event.ctrlKey ||
                                  event.shiftKey ||
                                  event.altKey
                                )
                                  return;
                                event.preventDefault();
                                revealProfileTarget(roleRowId(r));
                              }}
                              className={`time-role ${c.heldSeat ? 'time-role-office' : ''} ${!r.removedOn && !r.uncertainAfter ? 'time-open' : ''}`}
                              style={{
                                left: `${x(r.addedOn)}%`,
                                width: `${Math.max(0.15, x(end!) - x(r.addedOn))}%`,
                              }}
                              aria-label={label}
                              {...tipProps(() => roleTip(r, c.name, c.asOf, c.heldSeat))}
                            />
                          ) : (
                            <span key={i} className="small muted">
                              Няма установен период
                            </span>
                          );
                        }),
                      '',
                      under,
                    ),
                  )}
                  {c.contracts.some((r) => r.year) &&
                    row(
                      `${c.eik}-contracts`,
                      'Сключени договори',
                      c.contracts
                        .filter((r) => r.year)
                        .map((r) => {
                          const ownBuyers = (p.timeline.buyers ?? []).filter(
                            (b) => b.eik === c.eik && b.year === r.year && ownIds.has(b.id),
                          );
                          return (
                            <span
                              key={r.year}
                              className="time-contract-bin"
                              style={yearStyle(+r.year!)}
                            >
                              {r.tied > 0 && (
                                <Link
                                  to={contractHref(c.eik, r.year, 'tied')}
                                  className="time-contract eligible"
                                  aria-label={`${r.year}: ${plural(r.tied, 'договор', 'договора')}, подписани в година с декларация за длъжността, докато лицето е свързано с ${c.name}`}
                                  {...tipProps(() => contractsTip(r, c.name, 'tied'))}
                                >
                                  {count(r.tied)}
                                </Link>
                              )}
                              {r.contracts > r.tied && (
                                <Link
                                  to={contractHref(c.eik, r.year, 'untied')}
                                  className="time-contract context"
                                  aria-label={`${r.year}: ${plural(r.contracts - r.tied, 'договор', 'договора')} извън съвпадението на длъжността и връзката с ${c.name}`}
                                  {...tipProps(() => contractsTip(r, c.name, 'untied'))}
                                >
                                  {count(r.contracts - r.tied)}
                                </Link>
                              )}
                              {ownBuyers.length > 0 && (
                                <Explanation
                                  label={`${r.year}: възложител от институциите в декларациите · ${c.name}`}
                                  trigger={<InstitutionSymbol />}
                                  triggerClassName="time-institution-trigger"
                                  text={
                                    <>
                                      <strong>{r.year} · Институции от декларациите</strong>
                                      <ul className="entity-list time-buyers-list">
                                        {ownBuyers.map((b) => (
                                          <li key={b.id}>
                                            <Link
                                              to={contractHref(c.eik, r.year, 'all', b.id)}
                                              onClick={(event) =>
                                                event.currentTarget
                                                  .closest<HTMLElement>('[popover]')
                                                  ?.hidePopover()
                                              }
                                            >
                                              {b.name}
                                            </Link>{' '}
                                            · {count(b.contracts)}{' '}
                                            {b.contracts === 1 ? 'договор' : 'договора'} ·{' '}
                                            {money(b.valueEur)}
                                          </li>
                                        ))}
                                      </ul>
                                      <small>
                                        Съвпадението е по институция. Периодът на длъжността се
                                        установява отделно.
                                      </small>
                                    </>
                                  }
                                />
                              )}
                            </span>
                          );
                        }),
                      'time-contracts',
                      under,
                    )}
                  {procurements.length > 0 && (
                    <div className="time-lanes">
                      {packLanes(procurements).map((lane, i) =>
                        row(
                          `${c.eik}-lane-${i}`,
                          i === 0 ? <small>Поръчки: обявяване → подписване</small> : null,
                          lane.map((pr) => procurementMark(pr, under)),
                          'time-lane',
                          under,
                        ),
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      {tip && (
        <div
          className="help-popover time-tip"
          aria-hidden="true"
          style={{ left: tip.left, top: tip.top, bottom: tip.bottom }}
        >
          {tip.content}
        </div>
      )}
      <p className="small muted person-time-note">
        Числата са брой договори за годината. Червеното означава година с налична декларация за
        институция и длъжност на лицето, независимо от периода на участие в дружеството. Това не
        установява точните дати на мандата; липсата на декларация не доказва липса на длъжност.
        Черните отсечки показват отделно вписаните роли в дружествата.
        {heldSeats &&
          ' Отсечките с контур са вписани роли, които са заемана длъжност: под тях няма съвпадение, а договорите на организацията не се отнасят към лицето.'}{' '}
        При липсващи дати не извеждаме период.
      </p>
    </Section>
  );
}

type ProcurementKind = 'tied' | 'announced' | 'context';
interface TimelineTip {
  content: ReactNode;
  left: number;
  top?: number;
  bottom?: number;
}

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const yearsLabel = (from: string, to: string) =>
  from.slice(0, 4) === to.slice(0, 4)
    ? `${from.slice(0, 4)} г.`
    : `${from.slice(0, 4)}–${to.slice(0, 4)} г.`;

function declarationTip(d: PersonDeclaration, context: string | undefined, disputed: boolean) {
  return (
    <>
      <strong className="time-tip-title">{declarationTypeLabel(d)}</strong>
      {d.year && <span>За {d.year} г.</span>}
      {d.institution && (
        <span>
          {d.institution}
          {d.position ? ` · ${d.position}` : ''}
        </span>
      )}
      {d.office?.work && (
        <span>
          Месторабота според декларацията: <span className="verbatim">„{d.office.work}“</span>
        </span>
      )}
      {context && <span>{context}</span>}
      {d.declaredOn && <span>Дата на документа {date(d.declaredOn)}</span>}
      {d.submittedOn && d.submittedOn !== d.declaredOn && (
        <span>Подадена {date(d.submittedOn)}</span>
      )}
      {disputed && (
        <span className="time-tip-overlap">
          Разминаване: дялът липсва в друга декларация за същата година
        </span>
      )}
      <small className="muted">Кликни, за да видиш декларацията</small>
    </>
  );
}

function officeTip(institution: string, positions: string[], o: OfficeSpan) {
  const first = o.from.slice(0, 4),
    last = o.to.slice(0, 4);
  return (
    <>
      <strong className="time-tip-title">{institution}</strong>
      {positions.length > 0 && <span>{positions.join('; ')}</span>}
      <span>Години с декларация: {yearsLabel(o.from, o.to)}</span>
      <span>
        {o.knownStart
          ? `Встъпителна декларация ${date(o.knownStart)}`
          : `Началото не е известно — първата декларация е за ${first} г.`}
      </span>
      <span>
        {o.knownEnd
          ? `Финална декларация ${date(o.knownEnd)}`
          : `Краят не е известен — последната декларация е за ${last} г.`}
      </span>
      {(o.knownStart || o.knownEnd) && (
        <small className="muted">Декларацията се подава до месец след събитието.</small>
      )}
    </>
  );
}

function roleTip(r: PersonRole, company: string, asOf: string | null, held = false) {
  return (
    <>
      <strong className="time-tip-title">{ROLE_LABEL[r.role]}</strong>
      <span>{company}</span>
      {held && <span>Заемана длъжност, не частен интерес</span>}
      <span>Вписана {date(r.addedOn)}</span>
      <span>
        {r.removedOn
          ? `Заличена ${date(r.removedOn)}`
          : r.uncertainAfter
            ? `Неустановено след ${date(r.uncertainAfter)}`
            : `В сила към ${date(asOf)} — последна справка в регистъра`}
      </span>
      {r.sharePct != null && <span>Дял {pct(r.sharePct)}</span>}
      <span>Вписване № {r.entryNumber}</span>
      <small className="muted">Кликни за реда в таблицата с роли</small>
    </>
  );
}

function contractsTip(r: TimelineContracts, company: string, part: 'tied' | 'untied') {
  return (
    <>
      <strong className="time-tip-title">
        {r.year} ·{' '}
        {part === 'tied'
          ? `${plural(r.tied, 'договор', 'договора')} в съвпадение`
          : `${plural(r.contracts - r.tied, 'договор', 'договора')} извън съвпадението`}
      </strong>
      <span>{company}</span>
      {part === 'tied' && (
        <span className="time-tip-overlap">
          Подписани в година с декларация за длъжността, докато лицето е свързано с дружеството
        </span>
      )}
      <span>
        Всички за годината: {plural(r.contracts, 'договор', 'договора')} · {money(r.valueEur)}
      </span>
      <small className="muted">Кликни за списъка с договорите</small>
    </>
  );
}

function bandTip(from: string, to: string) {
  return (
    <>
      <strong className="time-tip-title">Съвпадение</strong>
      <span className="time-tip-value">
        {date(from)} – {date(to)}
      </span>
      <span>
        Години с декларация за длъжността, докато лицето е свързано с дружеството. Договорите,
        подписани в този период, са червени.
      </span>
    </>
  );
}

function declaredTip(label: string, company: string, from: string, to: string) {
  return (
    <>
      <strong className="time-tip-title">{label}</strong>
      <span>{company}</span>
      <span className="time-tip-value">{yearsLabel(from, to)}</span>
      <span>Годините, в които декларациите свързват лицето с дружеството.</span>
    </>
  );
}

function procurementTip(pr: TimelineProcurement, kind: ProcurementKind, own: boolean) {
  const days = pr.announcedAt
    ? Math.round((Date.parse(pr.signedAt) - Date.parse(pr.announcedAt)) / 864e5)
    : null;
  return (
    <>
      <strong className="time-tip-title">{pr.subject || 'Договор'}</strong>
      <span className="time-tip-value">{money(pr.valueEur)}</span>
      <span>{pr.authority}</span>
      {own && (
        <span className="time-tip-own">
          <InstitutionSymbol /> Възложител от институциите в декларациите
        </span>
      )}
      <span>
        {pr.announcedAt
          ? `Обявена ${date(pr.announcedAt)} → подписан ${date(pr.signedAt)} · ${plural(days!, 'ден', 'дни')}`
          : `Подписан ${date(pr.signedAt)}`}
      </span>
      {pr.bids != null && (
        <span>{pr.bids === 1 ? 'Една оферта' : `Оферти: ${count(pr.bids)}`}</span>
      )}
      {kind !== 'context' && (
        <span className="time-tip-overlap">
          {kind === 'tied'
            ? 'Подписан по време на съвпадението'
            : 'Обявена по време на съвпадението, подписана извън него'}
        </span>
      )}
      <small className="muted">Кликни за целия договор</small>
    </>
  );
}
