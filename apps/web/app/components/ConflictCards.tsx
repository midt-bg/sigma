import { useId, useRef, useState, type CSSProperties } from 'react';
import { Link, useFetcher } from 'react-router';
import { count, money, pct, plural } from '@sigma/shared';
import type { ConflictContract, ConflictLink, LinkContracts } from '@sigma/api-contract';
import { Chip, ExternalEikLink, ShareBar } from './ui';
import {
  authorityShares,
  authorityShareDisplay,
  companyProfileHref,
  contractHref,
  contractTimeline,
  contractYear,
  contractYearsLabel,
  contractsCountLabel,
  fundsCellLabel,
  fundsMagnitude,
  hasContemporaneousContracts,
  isHttpsUrl,
  linkContractsHref,
  officialHref,
  partitionContracts,
  relationLabel,
  temporalLabel,
} from '../lib/conflicts';

// Свързани лица — a ranked, paginated list of declared-ownership CASE-CARDS (not a table). All branching
// lives in ../lib/conflicts (tested); this only emits markup. `omit` drops the redundant party on a
// single-subject page (an office-holder's own page omits the office-holder; a winner's page omits the
// company). Each card carries identity + a signal strip and expands to a lazily-fetched case detail
// (magnitude bar, timeline, contract list) — fetched on demand so the leaderboard payload stays lean.
export function ConflictCards({
  links,
  caption,
  omit,
  startRank = 0,
  totalCount,
}: {
  links: ConflictLink[];
  caption: string;
  omit?: 'official' | 'company';
  // Rank of the row BEFORE the first shown (paginated leaderboards); 0 on unpaginated per-entity views.
  startRank?: number;
  // Total across ALL pages, for aria-setsize (so AT announces global rank though the DOM holds one page).
  // Defaults to the shown count — correct on the unpaginated per-entity views; pass the full count when paginating.
  totalCount?: number;
}) {
  const setSize = totalCount ?? links.length;
  return (
    <ol className="conflict-cards" role="list" aria-label={caption}>
      {links.map((l, i) => (
        <ConflictCard
          key={l.linkKey}
          link={l}
          rank={startRank + i + 1}
          setSize={setSize}
          omit={omit}
        />
      ))}
    </ol>
  );
}

function ConflictCard({
  link: l,
  rank,
  setSize,
  omit,
}: {
  link: ConflictLink;
  rank: number;
  setSize: number;
  omit?: 'official' | 'company';
}) {
  const fetcher = useFetcher<LinkContracts>();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const panelId = useId();
  const funds = fundsCellLabel(l);
  const conflict = hasContemporaneousContracts(l);
  const loaded = fetcher.data != null;
  // Guards a double-fetch from a rapid re-toggle before React commits (fetcher.state is a stale closure read).
  const requested = useRef(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !requested.current) {
      requested.current = true;
      fetcher.load(linkContractsHref(l)); // lazy-load once; cached by the card thereafter
    }
  }

  // Names the expanded region so several open cards on one page stay distinguishable to screen readers.
  const subject =
    omit === 'official'
      ? l.company
      : omit === 'company'
        ? l.official
        : `${l.official} / ${l.company}`;

  return (
    <li aria-posinset={rank} aria-setsize={setSize}>
      <article
        className={`conflict-card${conflict ? ' has-conflict' : ''}`}
        aria-labelledby={titleId}
      >
        <span className="cc-rank" aria-hidden="true">
          № {rank}
        </span>

        <h3 id={titleId} className="cc-title">
          {omit !== 'official' && <Link to={officialHref(l.officialSlug)}>{l.official}</Link>}
          {omit !== 'official' && omit !== 'company' && (
            <span className="cc-arrow" aria-hidden="true">
              →
            </span>
          )}
          {omit !== 'company' && (
            <>
              <Link to={companyProfileHref(l.eik)}>{l.company}</Link>
              <ExternalEikLink eik={l.eik} />
            </>
          )}
        </h3>

        <div className="cc-interest">
          <span>{relationLabel(l.relation)}</span>
          {l.ownInstitution && <Chip tone="strong">от собствената институция</Chip>}
          {l.contemporaneous && <Chip tone="window">към момента на договор</Chip>}
          {(l.firstDeclaredYear || l.lastDeclaredYear) && (
            <span className="small muted">
              деклариран {contractYearsLabel(l.firstDeclaredYear, l.lastDeclaredYear)} г.
            </span>
          )}
        </div>

        <dl className="cc-stats">
          <div className="cc-stat">
            <dt>Договори</dt>
            <dd>{contractsCountLabel(l)}</dd>
          </div>
          <div className="cc-stat">
            <dt>Публични средства</dt>
            <dd>
              <span className="cc-funds-primary" title="по договори в декларирания период">
                {funds.primary}
              </span>
              {funds.total && <span className="cc-funds-total">от {funds.total}</span>}
            </dd>
          </div>
          <div className="cc-stat">
            <dt>Период</dt>
            <dd>{contractYearsLabel(l.firstContractYear, l.lastContractYear)}</dd>
          </div>
          <div className="cc-stat">
            <dt>Източник</dt>
            <dd>
              {isHttpsUrl(l.sourceUrl) ? (
                <a href={l.sourceUrl!} target="_blank" rel="noopener noreferrer">
                  декларация
                </a>
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
          </div>
        </dl>

        {l.contractCount > 0 && (
          <>
            <div className="cc-footer">
              <button
                type="button"
                className="cc-toggle"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
              >
                {open ? 'Скрий договорите' : 'Виж договорите'}
                <span className="cc-chevron" aria-hidden="true" />
              </button>
            </div>
            <div className="cc-disclosure" data-open={open}>
              <div className="cc-disclosure-inner">
                <div
                  id={panelId}
                  role="region"
                  aria-label={`Договори — ${subject}`}
                  className="cc-panel"
                  inert={!open}
                  data-state={loaded ? 'loaded' : 'loading'}
                >
                  {fetcher.data ? (
                    <CaseDetail link={l} contracts={fetcher.data.contracts} />
                  ) : fetcher.state === 'loading' ? (
                    <p className="muted small m-0" role="status">
                      Зареждане на договорите…
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )}
      </article>
    </li>
  );
}

// The expanded case, in three headed sub-sections: the magnitude bar (how much of the money moved while the
// stake was declared), a timeline placing each contract against the declared window, and the contract list.
function CaseDetail({ link: l, contracts }: { link: ConflictLink; contracts: ConflictContract[] }) {
  const mag = fundsMagnitude(l);
  const funds = fundsCellLabel(l);
  return (
    <div className="cc-case">
      {mag != null && funds.total && (
        <section className="cc-section">
          <h4 className="cc-section-title">В декларирания период</h4>
          <div className="case-mag">
            <ShareBar ratio={mag} warn />
            <span className="case-mag-figures">
              <strong>{funds.primary}</strong> от {funds.total}
            </span>
          </div>
        </section>
      )}
      <Timeline link={l} contracts={contracts} />
      <AuthorityShares contracts={contracts} />
      <ContractList contracts={contracts} />
    </div>
  );
}

// How big a slice of each awarding body's recorded procurement this winner captured — the materiality axis
// the timeline lacks (a small sum can still be a huge share of a small municipality). Each row is a stat:
// the body + its capture share paired on one line, a neutral bar tied directly beneath, then the figures.
// The bar is neutral (a high share is a question, not a verdict); a contract in the declared window is marked.
function AuthorityShares({ contracts }: { contracts: ConflictContract[] }) {
  const shares = authorityShares(contracts);
  if (shares.length === 0) return null;
  return (
    <section className="cc-section">
      <h4 className="cc-section-title">Дял при възложителите</h4>
      <ul className="auth-shares" role="list">
        {shares.map((s) => {
          const display = authorityShareDisplay(s);
          const bar = display.mode === 'bar';
          // The share value labels the body. „под 0,1%" for a real sub-threshold capture, „—" when there is
          // no denominator/value — both muted, so only a plottable share reads as a hard number.
          const pctLabel = bar ? pct(display.ratio, 1) : display.mode === 'tiny' ? 'под 0,1%' : '—';
          return (
            <li key={s.authorityId} className="auth-share">
              <div className="auth-share-top">
                <span className="auth-share-name">
                  {s.authority}
                  {s.inWindow && <Chip tone="window">в декларирания период</Chip>}
                </span>
                <span className={`auth-share-pct${bar ? '' : ' is-muted'}`}>{pctLabel}</span>
              </div>
              {(bar || display.mode === 'tiny') && (
                <span className="auth-bar" aria-hidden="true">
                  {bar && <i style={{ width: `${(display.ratio * 100).toFixed(1)}%` }} />}
                </span>
              )}
              <span className="auth-share-figures small muted">
                {display.mode === 'no-value' ? (
                  'сума не е налична'
                ) : (
                  <>
                    {money(s.companyEur)}
                    {s.authorityTotalEur != null && (
                      <> от общо {money(s.authorityTotalEur)} възложени</>
                    )}
                  </>
                )}
                {' · '}
                <span className="auth-share-count">
                  {count(s.contractCount)} {plural(s.contractCount, 'договор', 'договора')}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Contracts as dots on a year axis, the declared-stake window as a shaded band. Renders only when at least
// one contract is dated (contractTimeline returns null otherwise) — the list below still covers undated ones.
function Timeline({ link: l, contracts }: { link: ConflictLink; contracts: ConflictContract[] }) {
  const tl = contractTimeline(l, contracts);
  if (!tl) return null;
  const inCount = tl.marks.filter((m) => m.inWindow).length;
  const dated = tl.marks.length;
  // Agree the noun + verb with the count — „1 датиран договор е сключен" vs „17 датирани договора са сключени".
  const datedNoun = plural(dated, 'датиран договор', 'датирани договора');
  const datedVerb = plural(dated, 'е сключен', 'са сключени');
  // Narrow both edges inline: TS loses the narrowing if it's hidden behind an intermediate boolean.
  const ws = tl.windowStartPct;
  const we = tl.windowEndPct;
  const hasBand = ws != null && we != null;
  const bandLeft = ws != null && we != null ? Math.min(ws, we) : 0;
  const bandWidth = ws != null && we != null ? Math.abs(we - ws) : 0;
  const maxStack = tl.marks.reduce((m, k) => Math.max(m, k.stackIndex), 0);
  return (
    <section className="cc-section">
      <h4 className="cc-section-title">
        Времева ос · дял {contractYearsLabel(l.firstDeclaredYear, l.lastDeclaredYear)} г. срещу
        договори
      </h4>
      <div
        className="tl-track"
        style={{ height: `${34 + (maxStack + 1) * 14}px` }}
        role="img"
        aria-label={`${count(inCount)} от ${count(dated)} ${datedNoun} ${datedVerb} в декларирания период`}
      >
        <div className="tl-axis" />
        {hasBand && (
          <div className="tl-band" style={{ left: `${bandLeft}%`, width: `${bandWidth}%` }} />
        )}
        {tl.marks.map((m) => (
          <span
            key={`${m.year}-${m.stackIndex}`}
            className={`tl-mark ${m.inWindow ? 'in' : 'out'}`}
            style={{ left: `${m.leftPct}%`, top: `${24 + m.stackIndex * 14}px` }}
            title={String(m.year)}
          />
        ))}
        {tl.ticks.map((t) => (
          <span key={t.year} className="tl-year" style={tickStyle(t.leftPct)}>
            {t.year}
          </span>
        ))}
      </div>
      <p className="tl-legend">
        <span className="tl-dot in" aria-hidden="true" /> в декларирания период
        <span className="tl-sep">·</span>
        <span className="tl-dot out" aria-hidden="true" /> извън периода
      </p>
    </section>
  );
}

// Anchor a year label: flush-left at the start, flush-right at the end, centred on its tick otherwise —
// so the outermost labels never overflow the track (dots at the edges bleed ±half their width).
function tickStyle(pct: number): CSSProperties {
  if (pct <= 0) return { left: 0 };
  if (pct >= 100) return { right: 0 };
  return { left: `${pct}%`, transform: 'translateX(-50%)' };
}

function ContractList({ contracts }: { contracts: ConflictContract[] }) {
  if (contracts.length === 0)
    return (
      <section className="cc-section">
        <p className="muted small m-0">Няма намерени договори.</p>
      </section>
    );
  const { inConflict, outside } = partitionContracts(contracts);
  return (
    <section className="cc-section">
      {inConflict.length > 0 ? (
        <>
          <h4 className="cc-section-title">
            Договори, сключени в декларирания период ({count(inConflict.length)})
          </h4>
          <ul className="contract-list">
            {inConflict.map((c, i) => (
              <ContractItem key={c.contractNumber ?? `in-${i}`} c={c} conflict />
            ))}
          </ul>
        </>
      ) : (
        <p className="small muted m-0">Няма договори, сключени в декларирания период.</p>
      )}
      {outside.length > 0 && (
        <details className="contract-outside">
          <summary className="small muted">Извън периода ({count(outside.length)})</summary>
          <ul className="contract-list">
            {outside.map((c, i) => (
              <ContractItem key={c.contractNumber ?? `out-${i}`} c={c} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ContractItem({ c, conflict = false }: { c: ConflictContract; conflict?: boolean }) {
  return (
    <li className={conflict ? 'contract-item contract-item-conflict' : 'contract-item'}>
      {/* The tender subject (предмет) — what the money bought — leads; it's the concrete fact a reader wants. */}
      {c.subject && <span className="contract-subject">{c.subject}</span>}
      <span className="contract-meta">
        <span className="contract-year">{contractYear(c)}</span>
        <span className="contract-authority">{c.authority || '—'}</span>
        {/* Award procedure verbatim (open vs direct/no-notice) — the competition signal. Shown neutrally for
            now; emphasis + a "без открита процедура" aggregate wait until the ЗОП type allowlist is pinned. */}
        {c.procedureType && <span className="contract-procedure">{c.procedureType}</span>}
        {c.contractKind && <span className="contract-kind">{c.contractKind}</span>}
        <Link to={contractHref(c)} className="contract-link">
          {c.contractNumber ? `№ ${c.contractNumber}` : 'договор'}
        </Link>
        <span className="contract-amt">{money(c.amountEur)}</span>
        {/* In-window items sit under the „…в декларирания период" heading + carry a left accent rail,
            so a per-item chip would just repeat that; only the outside items need a temporal tag. */}
        {!conflict && <span className="small muted">{temporalLabel(c.temporal)}</span>}
      </span>
    </li>
  );
}
