// @vitest-environment jsdom
import type { ContractDetail, ContractParty } from '@sigma/api-contract';
import { fakeD1 } from '@sigma/test-support';
import {
  createRequestHandler,
  Meta,
  Outlet,
  UNSAFE_withComponentProps,
  type AppLoadContext,
  type ServerBuild,
} from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import entry from '../entry.server';
import routeConfig from '../routes';
import * as contractRoute from './contract';

const { getContract } = vi.hoisted(() => ({
  getContract: vi.fn<(db: unknown, id: string) => Promise<ContractDetail | null>>(),
}));

vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getContract,
}));

const origin = 'https://example.invalid';
const slug = 'fixture%2Faward';
const contractRouteId = 'routes/contract.tsx';
const { path } = routeConfig.find(({ file }) => file === contractRouteId)!;
const routeAsset = {
  module: '',
  hasAction: false,
  hasLoader: true,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
};

function Document() {
  return (
    <html lang="bg">
      <head>
        <Meta />
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  );
}

// Supply a minimal framework build so the real server entry, matched loader, Meta and page
// render together. The root fixture supplies the same origin data the route uses in production.
// Use the same component-props adapter that the React Router build plugin adds to route modules.
const moduleForBuild = contractRoute as unknown as NonNullable<
  ServerBuild['routes'][string]
>['module'];
const handle = createRequestHandler(
  {
    entry: { module: { default: entry } },
    routes: {
      root: {
        id: 'root',
        path: '',
        module: {
          default: Document,
          loader: () => ({ origin }),
          ErrorBoundary: () => <p>Договорът не е намерен</p>,
        },
      },
      [contractRouteId]: {
        id: contractRouteId,
        parentId: 'root',
        path,
        module: {
          ...moduleForBuild,
          default: UNSAFE_withComponentProps(
            contractRoute.default as unknown as Parameters<typeof UNSAFE_withComponentProps>[0],
          ),
        },
      },
    },
    assets: {
      entry: { imports: [], module: '' },
      routes: {
        root: { ...routeAsset, id: 'root', path: '', hasErrorBoundary: true },
        [contractRouteId]: {
          ...routeAsset,
          id: contractRouteId,
          parentId: 'root',
          path,
          hasErrorBoundary: false,
        },
      },
      url: '',
      version: 'fixture',
    },
    basename: '/',
    publicPath: '/',
    assetsBuildDirectory: '',
    unstable_getCriticalCss: undefined,
    allowedActionOrigins: undefined,
    future: {
      v8_middleware: false,
      v8_passThroughRequests: false,
      v8_trailingSlashAwareDataRequests: false,
    },
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
  },
  'production',
);

const { db } = fakeD1([]);
const party: ContractParty = {
  slug: 'fixture-authority',
  displayName: 'Община Учебна',
  name: 'Община Учебна',
  orderingUnit: null,
  typeLabel: null,
  settlement: null,
  eik: null,
  sector: null,
  totalContracts: 8,
  totalEur: 4_200,
};
const bidder: ContractParty = {
  ...party,
  slug: 'fixture-bidder',
  name: 'ПРИМЕРНИ ДОСТАВКИ ЕООД',
  displayName: 'ПРИМЕРНИ ДОСТАВКИ ЕООД',
  legalForm: 'EOOD',
  totalContracts: 1,
  totalEur: 600,
};

const emptyValue: ContractDetail['value'] = {
  estimatedEur: null,
  procedureEstimatedEur: null,
  signingEur: null,
  currentEur: null,
  deltaPct: null,
  suspect: false,
  flag: 'ok',
  currentValueDoubled: false,
};

function fixture(overrides: Partial<ContractDetail> = {}): ContractDetail {
  return {
    id: slug,
    subject: 'Доставка на учебни материали',
    unp: 'УНП-ТЕСТ',
    contractNumber: null,
    documentNumber: null,
    eopTenderId: null,
    lotLabel: null,
    signedAt: null,
    publishedAt: null,
    dateSuspect: false,
    startDate: null,
    endDate: null,
    contractKind: null,
    cpvCode: null,
    cpvDescription: null,
    sector: null,
    procedureLabel: 'Открита процедура',
    bidsReceived: null,
    bidsRejected: null,
    bidsSme: null,
    bidsNonEea: null,
    euFunded: null,
    euProgramme: null,
    durationDays: null,
    value: emptyValue,
    frameworkAwards: null,
    frameworkAgreement: false,
    authority: party,
    bidder,
    lots: null,
    subcontractor: null,
    cohort: null,
    amendments: [],
    ...overrides,
  };
}

async function render(contract: ContractDetail | null) {
  getContract.mockResolvedValueOnce(contract);
  const request = new Request(`${origin}/contracts/${slug}`, {
    headers: { 'User-Agent': 'Googlebot' },
  });
  const response = await handle(request, {
    cloudflare: { env: { DB: db }, ctx: {} } as AppLoadContext['cloudflare'],
  });
  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  return { response, document };
}

const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
const section = (document: Document, id: string) =>
  document.querySelector(`section[aria-labelledby="${id}"]`)!;
const facts = (document: Document) =>
  Object.fromEntries(
    [...section(document, 'facts').querySelectorAll('dt')].map((term) => {
      const definition = term.nextElementSibling!.cloneNode(true) as Element;
      const note = definition.querySelector('.sub');
      note?.remove();
      return [text(term), { value: text(definition), note: text(note) }];
    }),
  );
const valueFigures = (document: Document) =>
  [...section(document, 'values').querySelectorAll('strong.num')].map(text);
const valueBadges = (document: Document) =>
  [...section(document, 'values').querySelectorAll('.vh')].map((column) =>
    text(column.querySelector('.value-badge')),
  );

const emptyAnnex: ContractDetail['amendments'][number] = {
  date: null,
  documentNumber: null,
  description: null,
  valueAfterEur: null,
  deltaEur: null,
  restated: false,
  suspect: false,
};

describe('contract document', () => {
  it('renders a normal award with gross and admitted bids, clean values, and public data links', async () => {
    const sector = { code: '39', label: 'Обзавеждане и оборудване', short: 'Оборудване' };
    const contract = fixture({
      subject: 'Доставка на учебни материали и оборудване за кабинети по природни науки и техника',
      contractNumber: 'ТЕСТ-12',
      documentNumber: 'ТЕСТ-ДОК',
      eopTenderId: '900000001',
      lotLabel: '1',
      signedAt: '2026-02-01',
      publishedAt: '2026-02-03',
      startDate: '2026-02-04',
      endDate: '2026-02-14',
      contractKind: 'Доставки',
      cpvCode: '39162100',
      cpvDescription: 'Учебно оборудване',
      sector,
      bidsReceived: 5,
      bidsRejected: 1,
      bidsSme: 2,
      bidsNonEea: 1,
      euFunded: false,
      durationDays: 10,
      value: { ...emptyValue, estimatedEur: 700, signingEur: 600, currentEur: 660, deltaPct: 0.1 },
      authority: {
        ...party,
        orderingUnit: 'Учебен отдел',
        typeLabel: 'Тестова община',
        settlement: 'Учебно селище',
      },
      bidder: { ...bidder, eik: '000000001', settlement: 'Учебно селище', sector },
      cohort: {
        amountEur: 660,
        band: 'above-median',
        stats: {
          division: '39',
          pricedContracts: 40,
          p25Eur: 300,
          medianEur: 500,
          p75Eur: 800,
          p90Eur: 850,
          p95Eur: 900,
          p99Eur: 950,
        },
      },
    });
    const { response, document } = await render(contract);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.title).toBe(`${contract.subject} — СИГМА`);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      `${origin}/contracts/fixture%2Faward`,
    );
    expect(text(document.querySelector('h1'))).toBe(contract.subject);
    expect(document.querySelector('h1')?.classList.contains('t-md')).toBe(true);
    expect(text(document.querySelector('nav'))).toContain('УНП-ТЕСТ');
    expect(facts(document)).toMatchObject({
      'Номер на договор': { value: 'ТЕСТ-12', note: '· документ № ТЕСТ-ДОК' },
      'Обособена позиция': { value: '1' },
      Предмет: { value: contract.subject },
      Обект: { value: 'Доставки' },
      CPV: { value: '39162100 Учебно оборудване' },
      Сектор: { value: 'Оборудване' },
      'Брой оферти': { value: '5', note: '4 допуснати · 1 отстранена · 2 от МСП · 1 извън ЕИП' },
      'Финансиране от ЕС': { value: 'не' },
      'Подписан на': { value: '1 февруари 2026 г.' },
      'Публикуван в регистъра': { value: '3 февруари 2026 г.' },
      'Срок за изпълнение': { value: '10 дни' },
      'Начална дата': { value: '4 февруари 2026 г.' },
      'Очакван край': { value: '14 февруари 2026 г.' },
    });
    expect(valueFigures(document)).toEqual(['700 €', '600 €', '660 €']);
    expect(text(section(document, 'values'))).toContain('+10% спрямо сключване');
    expect(document.querySelector('.value-alert, #risk')).toBeNull();

    const parties = section(document, 'who');
    expect(text(parties)).toContain('Възложител по документа: Учебен отдел');
    expect(text(parties)).toContain('Тестова община Учебно селище');
    expect(text(parties.querySelector('a[href="/authorities/fixture-authority"]'))).toBe(
      'Община Учебна',
    );
    expect(text(parties.querySelector('a[href="/companies/fixture-bidder"]'))).toBe(bidder.name);
    const partyLinks = [...parties.querySelectorAll('a')];
    expect(
      partyLinks
        .filter((link) => text(link)?.includes('Договори между'))
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/contracts?authority=fixture-authority&bidder=fixture-bidder',
      '/contracts?authority=fixture-authority&bidder=fixture-bidder',
    ]);
    expect(parties.querySelector('a[aria-label*="000000001"]')?.getAttribute('target')).toBe(
      '_blank',
    );

    const similar = section(document, 'similar');
    expect(text(similar)).toContain(
      'над медианата сред 40 договора в сектор „Оборудване“ (CPV 39)',
    );
    expect(similar.querySelector('a')?.getAttribute('href')).toBe(
      '/contracts?sector=39&sort=value-desc',
    );
    const source = section(document, 'provenance');
    expect(
      source.querySelector('a[href="/contracts/fixture%2Faward.json"]')?.getAttribute('target'),
    ).toBe('_blank');
    expect(text(source)).toContain('машиночетим, всички полета — /contracts/fixture%2Faward.json');
    const downloads = [...source.querySelectorAll('a[download]')];
    expect(downloads.map(text)).toEqual([
      'Договори — storage.eop.bg (в нов раздел)',
      'Поръчки — storage.eop.bg (в нов раздел)',
      'Анекси — storage.eop.bg (в нов раздел)',
      'Обявления (OCDS) — storage.eop.bg (в нов раздел)',
    ]);
    expect(
      downloads.every((link) =>
        link.getAttribute('href')?.startsWith('https://storage.eop.bg/open-data-2026-02-03/'),
      ),
    ).toBe(true);
    expect(text(document.querySelector('a[href="https://app.eop.bg/today/900000001"]'))).toContain(
      'Виж документите в ЦАИС ЕОП',
    );
  });

  it('shows missing figures and dates explicitly and omits links that need source identifiers', async () => {
    const { response, document } = await render(fixture({ unp: '' }));
    expect(response.status).toBe(200);
    expect(text(document.querySelector('nav'))).toContain('fixture%2Faward');
    expect(valueFigures(document)).toEqual(['—', '—', '—']);
    expect(facts(document)).toMatchObject({
      'Брой оферти': {
        value: 'не е посочен в данните',
        note: 'самите оферти и стойностите им ги няма в АОП',
      },
      'Финансиране от ЕС': { value: 'няма данни' },
      'Подписан на': { value: 'липсва' },
      'Публикуван в регистъра': { value: 'липсва' },
      'Срок за изпълнение': { value: 'липсва за този запис' },
      'Начална дата': { value: 'липсва' },
      'Очакван край': { value: 'липсва' },
    });
    expect(facts(document)).not.toHaveProperty('Номер на договор');
    expect(text(section(document, 'who'))).toContain('непотвърден ЕИК');
    expect(
      document.querySelector('a.source-cta, a[download], #amendments, #lots, #similar, #risk'),
    ).toBeNull();
  });

  it('keeps a sole-trader contract public with noindex in both the response and document', async () => {
    const { response, document } = await render(
      fixture({
        bidder: { ...bidder, legalForm: 'ET', displayName: 'ЕТ УЧЕБЕН ПРИМЕР' },
        bidsReceived: 1,
        bidsRejected: 0,
        bidsSme: 0,
        bidsNonEea: 0,
        euFunded: true,
        euProgramme: 'Учебна програма',
        durationDays: 1,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(text(document.querySelector('a[href="/companies/fixture-bidder"]'))).toBe(
      'ЕТ УЧЕБЕН ПРИМЕР',
    );
    expect(text(document.querySelector('#risk'))).toContain(
      'Липса на конкуренция (със средства от ЕС)',
    );
    expect(facts(document)).toMatchObject({
      'Брой оферти': { value: '1', note: '1 допусната · 0 отстранени' },
      'Финансиране от ЕС': { value: 'да', note: 'Учебна програма' },
      'Срок за изпълнение': { value: '1 ден' },
    });
  });

  it('shows a corrected signing without a current value, a change percentage or an annex history', async () => {
    const { document } = await render(
      fixture({ value: { ...emptyValue, estimatedEur: 700, signingEur: 500 } }),
    );
    expect(valueFigures(document)).toEqual(['700 €', '500 €', '—']);
    expect(document.querySelector('#amendments')).toBeNull();
    expect(text(document.body)).not.toContain('спрямо сключване');
  });

  it('preserves the signing price and distinguishes corrected, suppressed and missing annex values', async () => {
    const clauseOne =
      '§ 1. Срокът за доставка на учебните комплекти се изменя. Първата пратка се предава по опис, подписан от представителите на двете страни. Уведомлението за приемане се изпраща след проверка на доставката.';
    const clauseTwo =
      '§ 2. Гаранционният срок остава непроменен. В приемателния протокол се посочва само количеството на получените комплекти.';
    const { response, document } = await render(
      fixture({
        value: {
          ...emptyValue,
          estimatedEur: 700,
          signingEur: 500,
          suspect: true,
          flag: 'annex_total_suspect',
          currentValueDoubled: true,
        },
        amendments: [
          {
            ...emptyAnnex,
            date: '2025-04-01',
            documentNumber: 'АНЕКС-ТЕСТ-1',
            description: 'Промяна в графика.',
            valueAfterEur: 500,
            deltaEur: 0,
          },
          {
            ...emptyAnnex,
            date: '2025-05-01',
            documentNumber: 'АНЕКС-ТЕСТ-2',
            description: `${clauseOne}\n${clauseTwo}`,
            valueAfterEur: 550,
            deltaEur: 50,
            restated: true,
          },
          { ...emptyAnnex, date: '2025-06-01', valueAfterEur: 990, deltaEur: 440, suspect: true },
          emptyAnnex,
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(valueFigures(document)).toEqual(['700 €', '500 €', '—']);
    expect(valueBadges(document)).toEqual([undefined, undefined, 'двойно отчетена']);
    expect(text(document.querySelector('.value-alert h3'))).toBe(
      'Текущата стойност изглежда отчетена двойно',
    );
    expect(document.querySelector('.value-alert a')?.getAttribute('href')).toBe(
      '/methodology#flagged',
    );
    const annexes = section(document, 'amendments');
    const rows = [...annexes.querySelectorAll('tbody tr')];
    expect(rows.map((row) => [...row.querySelectorAll('td')].slice(0, 3).map(text))).toEqual([
      ['1 април 2025 г.', '500', '0'],
      ['1 май 2025 г.', expect.stringMatching(/^550 коригиран тотал/), '+50'],
      ['1 юни 2025 г.', expect.stringMatching(/^— непотвърден тотал/), '—'],
      ['—', '—', '—'],
    ]);
    expect(text(rows[0]!.lastElementChild)).toBe('Промяна в графика.');
    expect(text(rows[2])).not.toContain('990');
    expect(text(rows[3]!.lastElementChild)).toBe('—');
    const expanded = rows[1]!.querySelector('details')!;
    expect(expanded.open).toBe(false);
    expect(text(expanded.querySelector('summary'))).toContain('покажи целия текст');
    expect(text(expanded.querySelector('summary'))).not.toContain('Гаранционният срок');
    expect([...expanded.querySelectorAll('p')].map(text)).toEqual([clauseOne, clauseTwo]);
    expect(text(annexes)).toContain('4 анекса');
    expect(text(annexes)).toContain('СИГМА не ги потвърждава за тоталите');
  });

  it('warns on both prices when the source shows a jump and explains the disputed signing date', async () => {
    const { document } = await render(
      fixture({
        signedAt: '2025-03-03',
        publishedAt: '2025-02-03',
        dateSuspect: true,
        bidsReceived: 1,
        value: {
          ...emptyValue,
          estimatedEur: 700,
          signingEur: 20,
          currentEur: 500,
          deltaPct: 24,
          flag: 'value_low',
          suspect: true,
        },
      }),
    );
    expect(valueFigures(document)).toEqual(['700 €', '20 €', '500 €']);
    expect(valueBadges(document)).toEqual([
      undefined,
      'скок след изменения',
      'скок след изменения',
    ]);
    expect(text(document.querySelector('.value-alert'))).toContain(
      'Стойността при сключване (20 €) и текущата (500 €) се разминават в пъти',
    );
    expect(facts(document)['Подписан на']?.value).toContain(
      'договорът е подписан след публикуване',
    );
    const risk = document.querySelector('#risk');
    expect(text(risk)).toContain('Липса на конкуренция:');
    expect(text(risk)).toContain('Ръст на стойността чрез анекси:');
    expect(text(risk)).toContain('договорът е подписан след датата си на публикуване');
    expect(risk?.querySelector('a[href="/methodology#flagged"]')).not.toBeNull();
  });

  it('links the other awarded lot, marks this lot as current, and leaves the unawarded lot unlinked', async () => {
    const { document } = await render(
      fixture({
        frameworkAwards: 4,
        lotLabel: '1',
        value: { ...emptyValue, estimatedEur: 700, procedureEstimatedEur: 1_600, signingEur: 600 },
        bidder: { ...bidder, kind: 'consortium' },
        subcontractor: { name: 'УЧЕБЕН ПОДИЗПЪЛНИТЕЛ', eik: '000000002', valueEur: 40 },
        lots: {
          unp: 'УНП-ТЕСТ',
          numLots: 3,
          estimatedTotalEur: 1_050,
          signedTotalEur: 900,
          rows: [
            {
              lotLabel: '1',
              subject: 'Учебно оборудване',
              contractId: slug,
              contractorName: bidder.name,
              contractorSlug: bidder.slug,
              estimatedEur: 700,
              signingEur: 600,
              isCurrent: true,
            },
            {
              lotLabel: '2',
              subject: 'Учебни комплекти',
              contractId: 'fixture%2Fother-award',
              contractorName: 'ВТОРИ УЧЕБЕН ИЗПЪЛНИТЕЛ',
              contractorSlug: 'fixture-other-bidder',
              estimatedEur: 350,
              signingEur: 300,
              isCurrent: false,
            },
            {
              lotLabel: '3',
              subject: 'Резервни материали',
              contractId: null,
              contractorName: null,
              contractorSlug: null,
              estimatedEur: null,
              signingEur: null,
              isCurrent: false,
            },
          ],
        },
      }),
    );
    expect(text(section(document, 'values'))).toContain('цялата преписка: 2 хил. €');
    expect(text(section(document, 'values'))).toContain('едно от 4 възлагания');
    const lots = section(document, 'lots');
    const [current, other, unawarded] = [...lots.querySelectorAll('tbody tr')];
    expect(current?.getAttribute('aria-current')).toBe('page');
    expect([...current!.querySelectorAll('strong')].map(text)).toEqual([
      'Учебно оборудване',
      bidder.name,
    ]);
    expect(current?.querySelector('a')).toBeNull();
    expect(other?.hasAttribute('aria-current')).toBe(false);
    expect([...other!.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/contracts/fixture%2Fother-award',
      '/companies/fixture-other-bidder',
    ]);
    expect(unawarded?.querySelector('a')).toBeNull();
    expect([...unawarded!.querySelectorAll('td')].map(text)).toEqual([
      '3',
      'Резервни материали',
      'няма сключен договор',
      '—',
      '—',
    ]);
    expect(text(lots)).toContain('Прогнозна стойност на всички лотове: 1 хил. €');
    expect(text(lots)).toContain('Сключени договори: 900 € при подписване.');
    const parties = section(document, 'who');
    expect(text(parties)).toContain('обединение');
    expect(text(parties)).toContain('Подизпълнител: УЧЕБЕН ПОДИЗПЪЛНИТЕЛ · ЕИК 000000002 · 40 €');
    expect(parties.querySelector('a[aria-label*="000000002"]')).not.toBeNull();
  });

  it('describes the framework figure as a ceiling and labels a future signing date', async () => {
    const subject =
      'Рамково споразумение за доставка на учебно оборудване и материали с монтаж, проверка на място, обучение на служителите и гаранционна поддръжка във всички учебни кабинети';
    const { document } = await render(
      fixture({
        subject,
        unp: '',
        contractNumber: 'РАМКА-ТЕСТ',
        cpvCode: '39162100',
        signedAt: '2099-01-03',
        dateSuspect: true,
        bidsReceived: 3,
        frameworkAgreement: true,
        value: { ...emptyValue, estimatedEur: 800, signingEur: 600, currentEur: 600 },
        bidder: { ...bidder, kind: 'framework_parties' },
        subcontractor: { name: 'УЧЕБЕН ПОДИЗПЪЛНИТЕЛ', eik: 'ТЕСТ', valueEur: null },
        amendments: [{ ...emptyAnnex, description: 'Промяна в графика.' }],
      }),
    );
    expect(document.querySelector('h1')?.classList.contains('t-sm')).toBe(true);
    expect(facts(document)).toMatchObject({
      Предмет: { value: subject },
      'Номер на договор': { value: 'РАМКА-ТЕСТ', note: undefined },
      CPV: { value: '39162100' },
      'Брой оферти': { value: '3', note: 'самите оферти и стойностите им ги няма в АОП' },
    });
    expect(facts(document)['Подписан на']?.value).toContain('тя е в бъдещето');
    expect(text(document.querySelector('#risk'))).toContain('датата на подписване е в бъдещето');
    expect(text(document.querySelector('nav'))).toContain('РАМКА-ТЕСТ');
    expect(text(section(document, 'values'))).toContain('рамково споразумение (таван)');
    expect(text(section(document, 'values'))).toContain('Не влиза в сумите и класациите на СИГМА');
    const parties = section(document, 'who');
    expect(text(parties)).toContain('страни по рамково споразумение');
    expect(text(parties)).toContain('Подизпълнител: УЧЕБЕН ПОДИЗПЪЛНИТЕЛ · ЕИК ТЕСТ');
    expect(parties.querySelector('a[aria-label*="ЕИК ТЕСТ"]')).toBeNull();
    expect(text(section(document, 'amendments'))).toContain('1 анекс');
    expect(text(section(document, 'amendments'))).not.toContain('не ги потвърждава');
  });

  it('returns a 404 for an unknown encoded contract', async () => {
    const { response, document } = await render(null);
    expect(response.status).toBe(404);
    expect(getContract).toHaveBeenLastCalledWith(expect.anything(), 'c:fixture/award');
    expect(document.querySelector('main')).toBeNull();
    expect(text(document.body)).toContain('Договорът не е намерен');
  });
});
