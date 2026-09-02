import { type CSSProperties, type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { count, money, pct, plural } from '@sigma/shared';
import type { ConflictContract, ConflictContractFacts, ConflictLink } from '@sigma/api-contract';
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
  markContracts,
  officialHref,
  partitionContracts,
  registryEvidenceLabel,
  relationLabel,
  temporalLabel,
} from '../lib/conflicts';

// The rich per-link case detail, lifted out of the retired ConflictCards so the person/company pages can
// render it EAGERLY (no lazy fetcher — those pages exist to show the detail, and the contracts are loaded
// server-side by getOfficialConflicts / getCompanyConflicts). Each sub-block keeps its original
// (link, contracts) prop contract. Styles stay in styles/conflict-cards.css (globally imported), shared
// with nothing else now that the list is a table.
//
// `perspective` chooses which party heads each block: 'official' pages head by the winning COMPANY (ЕИК +
// profile link, the counterparty the reader came to see), 'company' pages head by the OFFICIAL (institution
// sub-label + profile link). The other party is the page's own subject (named in the PageHeader), so it is
// never repeated inside a block — mirroring the old `omit`.

/** The eager list of per-link detail blocks for a person/company page. `contracts` is the ЕИК→contract-facts
 *  map the loader batched (one array per winner, not per link — #312 HIGH 1); each block marks its winner's
 *  facts against its OWN declared window (`markContracts`) and renders its full case with no lazy fetch. On a
 *  company page every link shares one ЕИК, so all blocks read the same facts array, each with its own split. */
export function ConflictDetail({
  links,
  contracts,
  perspective,
}: {
  links: ConflictLink[];
  contracts: Record<string, ConflictContractFacts[]>;
  perspective: 'official' | 'company';
}) {
  return (
    <ol className="conflict-detail-list" role="list">
      {links.map((l) => (
        <li key={l.linkKey}>
          <ConflictDetailBlock
            link={l}
            contracts={markContracts(
              contracts[l.eik] ?? [],
              l.firstDeclaredYear,
              l.lastDeclaredYear,
            )}
            perspective={perspective}
          />
        </li>
      ))}
    </ol>
  );
}

// One link's full detail, eagerly expanded: the counterparty header + interest strip + stat grid +
// provenance, then the CaseDetail (magnitude bar, timeline, per-authority shares, contract list).
function ConflictDetailBlock({
  link: l,
  contracts,
  perspective,
}: {
  link: ConflictLink;
  contracts: ConflictContract[];
  perspective: 'official' | 'company';
}) {
  const titleId = useId();
  const conflict = hasContemporaneousContracts(l);
  const funds = fundsCellLabel(l);
  // The head names the OTHER party (the page's own subject is in the PageHeader). Official page → the
  // winning company (ЕИК + profile link); company page → the official (institution sub-label + profile link).
  let head: ReactNode;
  if (perspective === 'official') {
    head = (
      <>
        <h3 id={titleId} className="cc-title">
          <Link to={companyProfileHref(l.eik)}>{l.company}</Link>
          <ExternalEikLink eik={l.eik} />
        </h3>
        <p className="cc-official-inst small muted">ЕИК&nbsp;{l.eik}</p>
      </>
    );
  } else {
    head = (
      <>
        <h3 id={titleId} className="cc-title">
          <Link to={officialHref(l.officialSlug)}>{l.official}</Link>
        </h3>
        {l.institution && <p className="cc-official-inst small muted">{l.institution}</p>}
      </>
    );
  }
  return (
    <article
      className={`conflict-card conflict-detail${conflict ? ' has-conflict' : ''}`}
      aria-labelledby={titleId}
    >
      {head}

      <div className="cc-interest">
        <span>{relationLabel(l.relation)}</span>
        {l.ownInstitution && <Chip tone="strong">от собствената институция</Chip>}
        {/* Live-derived (the read-time contemporaneous count), not the stored il.contemporaneous flag —
            so the chip can't claim „към момента на договор" from a flag that drifted out of sync with the
            current contract set. */}
        {conflict && <Chip tone="window">към момента на договор</Chip>}
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
        {/* The Trade Register fact the link's identity rests on (#279, ADR-0033) — the register records a
            ROLE, it does not certify the ownership claim, which comes from the official's own declaration. */}
        <div className="cc-stat">
          <dt>Регистър</dt>
          <dd>
            <ExternalEikLink eik={l.eik} />
            <span className="small muted cc-evidence">
              {registryEvidenceLabel(l)}
              {l.registryEntryDate ? ` · вписване ${l.registryEntryDate}` : ''}
              {l.registryEntryNumber ? ` · № ${l.registryEntryNumber}` : ''}
              {l.registryLookupDate ? ` · справка ${l.registryLookupDate}` : ''}
            </span>
          </dd>
        </div>
      </dl>

      {l.contractCount > 0 && <CaseDetail link={l} contracts={contracts} />}
    </article>
  );
}

// The expanded case, in three headed sub-sections: the magnitude bar (how much of the money moved while the
// stake was declared), a timeline placing each contract against the declared window, and the contract list.
export function CaseDetail({
  link: l,
  contracts,
}: {
  link: ConflictLink;
  contracts: ConflictContract[];
}) {
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
export function AuthorityShares({ contracts }: { contracts: ConflictContract[] }) {
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
export function Timeline({
  link: l,
  contracts,
}: {
  link: ConflictLink;
  contracts: ConflictContract[];
}) {
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

export function ContractList({ contracts }: { contracts: ConflictContract[] }) {
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
