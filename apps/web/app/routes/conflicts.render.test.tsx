// @vitest-environment jsdom
// Deep render tests for the /conflicts leaderboard route (#287). The list is now one row per PERSON: a
// `DataTable` fed by `groupByPerson(links)`, not a stack of per-relationship cards. These exercise the ACTUAL
// route component against realistic loader data (framework-mode `loaderData`) through a real React Router
// data router (createRoutesStub) so useSearchParams/Link resolve. The per-link CaseDetail / timeline /
// authority-shares / expand behaviour moved to the person + company detail pages (plan §3.3) and is covered
// by `conflict.pages.render.test.tsx` — deliberately NOT re-tested here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { ConflictLink } from '@sigma/api-contract';
import Conflicts, { meta, headers } from './conflicts';

// React needs this flag to run act() cleanly under the jsdom test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── fixtures ──────────────────────────────────────────────────────────────────
function link(over: Partial<ConflictLink> = {}): ConflictLink {
  return {
    linkKey: 'person:ivan|111',
    officialSlug: 'aXZhbg',
    official: 'Иван Петров',
    institution: 'Община Тест',
    company: 'ТРЕЙС ГРУП ХОЛД АД',
    eik: '111',
    relation: 'owns',
    contemporaneous: true,
    ownInstitution: true,
    firstDeclaredYear: '2019',
    lastDeclaredYear: '2023',
    matchMethod: 'exact_name_key',
    contractCount: 3,
    contractValueEur: 88_000_000,
    contemporaneousContractCount: 2,
    contemporaneousValueEur: 30_000_000,
    firstContractYear: '2020',
    lastContractYear: '2024',
    sourceUrl: 'https://register.cacbg.bg/2024/i.xml',
    // #279: a link only reaches the DTO when its identity rests on a Trade Register fact.
    evidenceKind: 'document',
    registryRole: 'owner',
    registryEntryNumber: '20110502101007',
    registryEntryDate: '2011-05-02',
    registryLookupDate: '2026-08-05',
    ...over,
  };
}

const familyLink = link({
  linkKey: 'person:kmet|333|family',
  officialSlug: 'a21ldA',
  official: 'Кмет Тестов',
  company: 'ЕВРОСТРОЙ 21 ЕООД',
  eik: '333',
  relation: 'related', // a close relative's stake — anonymized
  evidenceKind: 'confirmed' as const,
  registryRole: null,
  ownInstitution: false,
  contractCount: 1,
  contractValueEur: 250_000,
  contemporaneousContractCount: 1,
  contemporaneousValueEur: 250_000,
});

const zeroContractLink = link({
  linkKey: 'person:praz|900',
  officialSlug: 'cHJheg',
  official: 'Празен Тестов',
  company: 'ПРАЗЕН ООД',
  eik: '900',
  contemporaneous: false,
  ownInstitution: false,
  contractCount: 0,
  contractValueEur: null,
  contemporaneousContractCount: 0,
  contemporaneousValueEur: null,
  sourceUrl: null,
});

// ── jsdom render harness ───────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mount the /conflicts route through a real data router. The person page target only needs to resolve as a
 *  route so the title-column links have somewhere to point. */
async function renderConflicts(links: ConflictLink[]) {
  const Stub = createRoutesStub([
    { path: '/conflicts', Component: Conflicts, loader: () => ({ links }) },
    { path: '/conflicts/official/:slug', Component: () => null },
    { path: '/conflicts/company/:eik', Component: () => null },
    { path: '/conflicts/methodology', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/conflicts']} />);
  });
}

const text = () => container.textContent ?? '';
const bodyRows = () => [...container.querySelectorAll('tbody tr')];

describe('/conflicts route — render', () => {
  it('meta() marks the page noindex and titles it', () => {
    const tags = meta({ matches: [] } as never);
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
    expect(JSON.stringify(tags)).toContain('Свързани лица');
  });

  it('headers() carries the loader Cache-Control through', () => {
    const h = headers({
      loaderHeaders: new Headers({ 'Cache-Control': 'public, max-age=42' }),
    } as never);
    expect(h['Cache-Control']).toBe('public, max-age=42');
  });

  it('renders the empty state when there are no links (no summary, no table)', async () => {
    await renderConflicts([]);
    expect(text()).toContain('Все още няма публикувани връзки');
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders the summary totals and the magnitude bar for a populated leaderboard', async () => {
    await renderConflicts([link(), familyLink]);
    expect(text()).toContain('Длъжностни лица с деклариран дял');
    expect(text()).toContain('Връзки към изпълнители');
    // contemporaneous magnitude bar renders only when both totals are > 0
    expect(container.querySelector('.conflict-headline-mag')).not.toBeNull();
    expect(container.querySelector('.share-bar, [class*="share"]')).not.toBeNull();
  });

  it('renders a native table with a non-empty caption and every header scoped to its column', async () => {
    await renderConflicts([link()]);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const caption = table!.querySelector('caption');
    expect(caption?.textContent?.trim().length).toBeGreaterThan(0);
    const heads = [...table!.querySelectorAll('thead th')];
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    // Native table semantics only — the old synthetic list roles must be gone.
    expect(container.querySelector('[aria-posinset], [aria-setsize]')).toBeNull();
  });

  it('collapses N links for ONE person into a single row; the person is named once', async () => {
    // Two winners for the SAME official → one person row, not two. (Distinct ЕИК so it is not a family
    // collapse — genuinely two winners folded by groupByPerson.)
    await renderConflicts([
      link({ eik: '111', company: 'ТРЕЙС ГРУП ХОЛД АД', linkKey: 'k1' }),
      link({ eik: '222', company: 'ГБС АД', linkKey: 'k2' }),
    ]);
    const rows = bodyRows();
    expect(rows.length).toBe(1);
    // Named exactly once across the whole table body.
    const occurrences = rows.filter((r) => r.textContent?.includes('Иван Петров')).length;
    expect(occurrences).toBe(1);
  });

  it('ranks by the strongest link: a person whose STRONGEST link is strong is not sunk below a weak person', async () => {
    // Weak person: no own-institution, no contemporaneous. Strong person: two links, one weak and one strong
    // (own-institution + contemporaneous). If the sort ever regresses to per-link or to OR-ed flags summed,
    // the strong person could slip; rank = strongest SINGLE link must keep them first.
    const weak = link({
      officialSlug: 'weak',
      official: 'Слаб Тестов',
      eik: '700',
      ownInstitution: false,
      contemporaneous: false,
      contemporaneousContractCount: 0,
      contemporaneousValueEur: null,
    });
    const strongWeakHalf = link({
      officialSlug: 'strong',
      official: 'Силен Тестов',
      linkKey: 'strong-weak',
      eik: '810',
      ownInstitution: false,
      contemporaneous: false,
      contemporaneousContractCount: 0,
      contemporaneousValueEur: null,
    });
    const strongStrongHalf = link({
      officialSlug: 'strong',
      official: 'Силен Тестов',
      linkKey: 'strong-strong',
      eik: '811',
      ownInstitution: true,
      contemporaneousContractCount: 2,
      contemporaneousValueEur: 5_000_000,
    });
    // Feed weak FIRST so a naive stable sort would leave it on top if ranking were broken.
    await renderConflicts([weak, strongWeakHalf, strongStrongHalf]);
    const rows = bodyRows();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Силен Тестов');
    expect(rows[1].textContent).toContain('Слаб Тестов');
  });

  it('Публични средства shows the contemporaneous sum with the „от" total beneath', async () => {
    await renderConflicts([link()]); // 30 млн. window, 88 млн. total
    const row = bodyRows()[0];
    const funds = row.querySelector('td[data-label="Публични средства"]')!;
    expect(funds.textContent).toContain('30');
    expect(funds.textContent).toContain('млн.');
    expect(funds.textContent).toContain('от'); // the „от <total>" context line
    expect(funds.textContent).toContain('88');
  });

  it('Дружества: 3 distinct winners → the count; a single winner → its name', async () => {
    await renderConflicts([
      link({
        officialSlug: 'multi',
        official: 'Много Тестов',
        eik: '1',
        company: 'А АД',
        linkKey: 'm1',
      }),
      link({
        officialSlug: 'multi',
        official: 'Много Тестов',
        eik: '2',
        company: 'Б АД',
        linkKey: 'm2',
      }),
      link({
        officialSlug: 'multi',
        official: 'Много Тестов',
        eik: '3',
        company: 'В АД',
        linkKey: 'm3',
      }),
    ]);
    const multiRow = bodyRows().find((r) => r.textContent?.includes('Много Тестов'))!;
    const cell = multiRow.querySelector('td[data-label="Дружества"]')!;
    expect(cell.textContent).toContain('3'); // count, not a company name
    expect(cell.textContent).not.toContain('АД');

    // Single-winner person → the winner's NAME in the Дружества cell.
    await renderConflicts([link()]);
    const soleCell = bodyRows()[0].querySelector('td[data-label="Дружества"]')!;
    expect(soleCell.textContent).toContain('ТРЕЙС ГРУП ХОЛД АД');
  });

  it('признаци live in a SECONDARY column and a flag sourced from a SECOND link still renders', async () => {
    // A person whose FIRST link has no own-institution but a SECOND link does — the OR across links must
    // surface the chip. Both signals rendered as restrained chips (no inline colour/style).
    const primary = link({
      officialSlug: 'orflag',
      official: 'Флаг Тестов',
      linkKey: 'or-1',
      eik: '501',
      ownInstitution: false,
      contemporaneousContractCount: 0,
      contemporaneousValueEur: null,
    });
    const second = link({
      officialSlug: 'orflag',
      official: 'Флаг Тестов',
      linkKey: 'or-2',
      eik: '502',
      ownInstitution: true,
      contemporaneousContractCount: 1,
      contemporaneousValueEur: 1_000_000,
    });
    await renderConflicts([primary, second]);
    const row = bodyRows().find((r) => r.textContent?.includes('Флаг Тестов'))!;
    const signals = row.querySelector('td[data-label="Признаци"]')!;
    expect(signals.classList.contains('col-secondary')).toBe(true);
    expect(signals.textContent).toContain('от собствената институция'); // from the SECOND link
    expect(signals.textContent).toContain('към момента на договор');
    // Restrained chips, no new colour: chip class present, no inline style attribute.
    const chips = signals.querySelectorAll('.chip');
    expect(chips.length).toBeGreaterThan(0);
    expect([...chips].some((c) => c.getAttribute('style'))).toBe(false);
    // The corresponding header is a secondary column too (drops on tablet).
    const headers = [...container.querySelectorAll('thead th')];
    const signalsHead = headers.find((th) => th.textContent === 'Признаци')!;
    expect(signalsHead.classList.contains('col-secondary')).toBe(true);
  });

  it('a zero-contract / null-value person renders 0 договори and no NaN', async () => {
    await renderConflicts([zeroContractLink]);
    const row = bodyRows()[0];
    expect(row.querySelector('td[data-label="Договори"]')!.textContent).toContain('0');
    expect(text()).not.toContain('NaN');
    // No window money, so no „от" split — only the total (which is „—" for a null value).
    const funds = row.querySelector('td[data-label="Публични средства"]')!;
    expect(funds.textContent).not.toContain('NaN');
  });

  it('a family-linked person is named on the row, but the relative never is', async () => {
    await renderConflicts([familyLink]);
    const row = bodyRows()[0];
    expect(row.textContent).toContain('Кмет Тестов'); // the OFFICIAL is named
    expect(row.textContent).not.toContain('съпруг'); // relationship type never asserted
    expect(row.textContent).not.toContain('дете');
    // Title column carries the name+institution and links to the person page.
    const titleCell = row.querySelector('td.cell-title')!;
    const link = titleCell.querySelector('a')!;
    expect(link.getAttribute('href')).toContain('/conflicts/official/');
    // …and the identity-free „свързано лице" qualifier, so a family-ONLY row is not read as an own stake
    // (niki #312 MEDIUM 1). It states the kind, never who the relative is or the relationship type.
    expect(titleCell.textContent).toContain('свързано лице');
  });

  it('a self-stake row carries no „свързано лице" qualifier — the wording is family-AWARE, not blanket', async () => {
    // POSITIVE CONTROL for the qualifier: an own stake (relation 'owns') must NOT be tagged свързано лице,
    // else every row reads as anonymized and the distinction the qualifier exists to draw is lost.
    await renderConflicts([link()]);
    const titleCell = bodyRows()[0].querySelector('td.cell-title')!;
    expect(titleCell.textContent).not.toContain('свързано лице');
  });

  it('the rank column is a corner-badge cell and the title column carries data-label', async () => {
    await renderConflicts([link()]);
    const row = bodyRows()[0];
    expect(row.querySelector('td.cell-rank')).not.toBeNull();
    const title = row.querySelector('td.cell-title')!;
    expect(title.getAttribute('data-label')).toBe('Длъжностно лице');
  });

  it('paginates when the eligible persons exceed one page (100), showing one page of rows', async () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      link({
        linkKey: `k${i}`,
        officialSlug: `s${i}`,
        official: `Лице ${i}`,
        eik: String(1000 + i),
      }),
    );
    await renderConflicts(many);
    expect(bodyRows().length).toBe(100); // one page of PERSONS
    expect(
      container.querySelector('.pagination, nav[aria-label], [class*="pagination"]'),
    ).not.toBeNull();
  });
});
