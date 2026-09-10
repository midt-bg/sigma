import { type CSSProperties, type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { count, money, moneyBare, pct, plural } from '@sigma/shared';
import type { ConflictContract, ConflictContractFacts, ConflictLink } from '@sigma/api-contract';
import { Chip, ExternalEikLink, Section, ShareBar } from './ui';
import { FactsList } from './FactsList';
import { DataTable, type Column } from './DataTable';
import {
  authorityShareDisplay,
  authorityShares,
  companyProfileHref,
  contractHref,
  contractsCountLabel,
  contractTimeline,
  contractYear,
  contractYearsLabel,
  fundsCellLabel,
  fundsMagnitude,
  hasContemporaneousContracts,
  isHttpsUrl,
  markContracts,
  officialHref,
  officialRole,
  partitionContracts,
  registryEvidenceLabel,
  relationLabel,
  temporalLabel,
  type AuthorityShare,
} from '../lib/conflicts';

// The rich per-link case detail, rendered EAGERLY (no lazy fetcher — these pages exist to show the detail,
// and the contracts are loaded server-side by getOfficialConflicts / getCompanyConflicts).
//
// Built from the SAME parts as every other detail page. It used to have a private design
// language — a card <article> nobody else used, `.cc-stats` instead of FactsList, `.cc-section` + <h4>
// instead of Section + <h2>, `.contract-list` instead of DataTable — carried by a 464-line private
// stylesheet, and it nested h1 → h2 → h3 → h4 for a SINGLE company while every sibling page stops at
// h2 (h3 only for a pair inside a section). One company is now one <Section>, so the outline reads
// h1 → h2 (company) → h3 (timeline / shares / contracts), like the contract and authority pages.
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
    <>
      {links.map((l, i) => (
        <ConflictDetailBlock
          key={l.linkKey}
          link={l}
          // A section id must be a valid, stable HTML id and `linkKey` carries a person key with spaces
          // and Cyrillic. The ЕИК is the natural per-block identity on an official page; the index
          // disambiguates a company page, where every block shares one ЕИК.
          domId={`link-${i + 1}-${l.eik}`}
          contracts={markContracts(contracts[l.eik] ?? [], l.firstDeclaredYear, l.lastDeclaredYear)}
          perspective={perspective}
        />
      ))}
    </>
  );
}

// One link's full detail as a <Section>: the counterparty is the section heading, the interest strip and
// the key figures sit directly under it, then the timeline, the per-authority shares and the contracts.
function ConflictDetailBlock({
  link: l,
  domId,
  contracts,
  perspective,
}: {
  link: ConflictLink;
  domId: string;
  contracts: ConflictContract[];
  perspective: 'official' | 'company';
}) {
  const conflict = hasContemporaneousContracts(l);
  const funds = fundsCellLabel(l);
  const mag = fundsMagnitude(l);
  // The heading names the OTHER party (the page's own subject is in the PageHeader). Official page → the
  // winning company (ЕИК + profile link); company page → the official (institution sub-label + link).
  const title =
    perspective === 'official' ? (
      <>
        <Link to={companyProfileHref(l.eik)}>{l.company}</Link>
        <ExternalEikLink eik={l.eik} />
      </>
    ) : (
      <Link to={officialHref(l.officialSlug)}>{l.official}</Link>
    );
  const subLabel = perspective === 'official' ? `ЕИК\u00a0${l.eik}` : officialRole(l);

  return (
    <Section id={domId} title={title} hint={subLabel ?? undefined}>
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

      <FactsList
        label="Ключови показатели за връзката"
        rows={[
          { term: 'Договори', value: contractsCountLabel(l) },
          {
            // „Публични средства" alone left the reader to guess that the lead figure is the
            // declared-window subset and that the „от" figure is the COMPANY's whole procurement, not
            // the person's. Both are now labelled, and the share that used to be a
            // separate bar with its own heading rides here as the percentage it always was.
            term: 'Публични средства',
            value: (
              <>
                <span className="cc-funds-primary">{funds.primary}</span>
                <span className="cc-funds-window"> в декларирания период</span>
              </>
            ),
            sub: funds.total ? (
              <>
                от {funds.total} на дружеството по обществени поръчки
                {mag != null && <> · {pct(mag, 0)}</>}
              </>
            ) : undefined,
          },
          { term: 'Период', value: contractYearsLabel(l.firstContractYear, l.lastContractYear) },
          {
            term: 'Източник',
            value: isHttpsUrl(l.sourceUrl) ? (
              <a href={l.sourceUrl!} target="_blank" rel="noopener noreferrer">
                {l.sourceYear ? `декларация за ${l.sourceYear} г.` : 'декларация'}
              </a>
            ) : (
              <span className="muted">—</span>
            ),
          },
          {
            // The Trade Register fact the link's identity rests on (#279, ADR-0033) — the register records
            // a ROLE, it does not certify the ownership claim, which comes from the official's declaration.
            term: 'Регистър',
            value: <ExternalEikLink eik={l.eik} />,
            sub: (
              <>
                {registryEvidenceLabel(l)}
                {l.registryEntryDate ? ` · вписване ${l.registryEntryDate}` : ''}
                {l.registryEntryNumber ? ` · № ${l.registryEntryNumber}` : ''}
                {/* NOT NULL in the DTO — the claim always carries the date we read the deed. */}
                {` · справка ${l.registryLookupDate}`}
              </>
            ),
          },
        ]}
      />

      {l.contractCount > 0 && <CaseDetail link={l} contracts={contracts} />}
    </Section>
  );
}

// The expanded case: a timeline placing each contract against the declared window, the per-authority
// capture shares, and the contracts themselves.
//
// The „В декларирания период" bar that used to open this block is gone. It carried no number the funds
// figure above did not already carry — only the percentage, which now rides in that figure's sub-line
//. That removes one of the four sub-headings this block used to stack under a company.
export function CaseDetail({
  link: l,
  contracts,
}: {
  link: ConflictLink;
  contracts: ConflictContract[];
}) {
  return (
    <>
      <Timeline link={l} contracts={contracts} />
      <AuthorityShares contracts={contracts} />
      <ContractList contracts={contracts} />
    </>
  );
}

// How big a slice of each awarding body's recorded procurement this winner captured — the materiality axis
// the timeline lacks (a small sum can still be a huge share of a small municipality). The share is neutral
// (a high share is a question, not a verdict); a contract in the declared window is marked.
//
// Rendered as a DataTable with a ShareBar in the „Дял" column — exactly how the company and authority
// profiles show the same idea (company.tsx / authority.tsx), instead of the private `.auth-shares` list.
const authorityShareColumns: Column<AuthorityShare>[] = [
  {
    key: 'authority',
    header: 'Възложител',
    isTitle: true,
    cell: (s) => (
      <>
        {s.authority}
        {s.inWindow && <Chip tone="window">в декларирания период</Chip>}
      </>
    ),
  },
  {
    key: 'value',
    header: 'Получено (€)',
    align: 'money',
    cell: (s) =>
      authorityShareDisplay(s).mode === 'no-value' ? (
        <span className="muted">сума не е налична</span>
      ) : (
        moneyBare(s.companyEur)
      ),
  },
  {
    key: 'total',
    header: 'От общо (€)',
    align: 'money',
    secondary: true,
    cell: (s) => (s.authorityTotalEur != null ? moneyBare(s.authorityTotalEur) : '—'),
  },
  {
    key: 'contracts',
    header: 'Договори',
    align: 'num',
    secondary: true,
    cell: (s) => count(s.contractCount),
  },
  {
    key: 'share',
    header: 'Дял',
    cell: (s) => {
      const display = authorityShareDisplay(s);
      // Only a plottable share gets a bar. „под 0,1%" is a real sub-threshold capture; „—" means there is
      // no denominator or no value — neither may read as a hard number.
      if (display.mode === 'bar') return <ShareBar ratio={display.ratio} />;
      return <span className="muted">{display.mode === 'tiny' ? 'под 0,1%' : '—'}</span>;
    },
  },
];

export function AuthorityShares({ contracts }: { contracts: ConflictContract[] }) {
  const shares = authorityShares(contracts);
  if (shares.length === 0) return null;
  return (
    <>
      <h3 className="cc-subhead">Дял при възложителите</h3>
      <DataTable
        columns={authorityShareColumns}
        rows={shares}
        getKey={(s) => s.authorityId}
        caption="Дял на дружеството в поръчките на всеки възложител"
      />
    </>
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
  const description = `${count(inCount)} от ${count(dated)} ${datedNoun} ${datedVerb} в декларирания период`;
  return (
    <>
      <h3 className="cc-subhead">
        Времева ос · дял {contractYearsLabel(l.firstDeclaredYear, l.lastDeclaredYear)} г. срещу
        договори
      </h3>
      {/* The track is decoration; the sentence below it is the content. Previously the div itself carried
          role="img" with the sentence hidden in aria-label, so a sighted reader never got the summary and a
          screen-reader user got it with no way to reach the contracts it describes — they are in the table
          under this block. */}
      <div
        className="tl-track"
        style={{ height: `${34 + (maxStack + 1) * 14}px` }}
        aria-hidden="true"
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
      <p className="small muted m-0">{description}</p>
    </>
  );
}

// Anchor a year label: flush-left at the start, flush-right at the end, centred on its tick otherwise —
// so the outermost labels never overflow the track (dots at the edges bleed ±half their width).
function tickStyle(pct: number): CSSProperties {
  if (pct <= 0) return { left: 0 };
  if (pct >= 100) return { right: 0 };
  return { left: `${pct}%`, transform: 'translateX(-50%)' };
}

// The contracts, as the same kind of table as every other contract list on the site — subject / authority /
// procedure / kind / year / value — with the SUBJECT as the link.
//
// The old list did have links: 13 of them on the page that prompted this. But the anchor was the bare
// „№ 219949" token wedged between „Услуги" and the amount, while the subject — the only part a reader
// recognises and would click — was a plain <span>. The link existed; the click target did not.
const contractColumns: Column<ConflictContract>[] = [
  {
    key: 'subject',
    header: 'Предмет',
    isTitle: true,
    cell: (c) => (
      <Link to={contractHref(c)}>
        {c.subject || (c.contractNumber ? `Договор № ${c.contractNumber}` : 'Договор')}
      </Link>
    ),
  },
  { key: 'authority', header: 'Възложител', cell: (c) => c.authority || '—' },
  {
    key: 'procedure',
    header: 'Процедура',
    secondary: true,
    // Award procedure verbatim (open vs direct/no-notice) — the competition signal. Shown neutrally for
    // now; emphasis + a "без открита процедура" aggregate wait until the ЗОП type allowlist is pinned.
    cell: (c) => c.procedureType || '—',
  },
  { key: 'kind', header: 'Вид', secondary: true, cell: (c) => c.contractKind || '—' },
  { key: 'year', header: 'Година', align: 'num', cell: (c) => contractYear(c) },
  { key: 'amount', header: 'Стойност (€)', align: 'money', cell: (c) => moneyBare(c.amountEur) },
];

export function ContractList({ contracts }: { contracts: ConflictContract[] }) {
  if (contracts.length === 0) {
    return (
      <>
        <h3 className="cc-subhead">Договори</h3>
        <p className="muted small m-0">Няма намерени договори.</p>
      </>
    );
  }
  const { inConflict, outside } = partitionContracts(contracts);
  return (
    <>
      <h3 className="cc-subhead">
        Договори, сключени в декларирания период ({count(inConflict.length)})
      </h3>
      {inConflict.length > 0 ? (
        <DataTable
          columns={contractColumns}
          rows={inConflict}
          getKey={(c, i) => c.contractSlug || `in-${i}`}
          caption="Договори, сключени в декларирания период"
        />
      ) : (
        <p className="small muted m-0">Няма договори, сключени в декларирания период.</p>
      )}
      {outside.length > 0 && (
        <details className="contract-outside">
          <summary className="small muted">Извън периода ({count(outside.length)})</summary>
          <DataTable
            columns={[
              ...contractColumns,
              {
                key: 'temporal',
                header: 'Спрямо периода',
                secondary: true,
                cell: (c) => temporalLabel(c.temporal),
              },
            ]}
            rows={outside}
            getKey={(c, i) => c.contractSlug || `out-${i}`}
            caption="Договори извън декларирания период"
          />
        </details>
      )}
    </>
  );
}
