// Bulgarian message catalog — the source language and the structural reference. `en.ts` mirrors this
// shape (a missing key is a compile error). Chrome keys (nav/header/footer/error/og) live inline here;
// per-page and per-component strings live in ./bg/<namespace>.ts and are composed in below. Interpolation
// uses `{name}` placeholders resolved by makeT().

import { accessibility } from './bg/accessibility';
import { analytics } from './bg/analytics';
import { authorities } from './bg/authorities';
import { authority } from './bg/authority';
import { breadcrumbs } from './bg/breadcrumbs';
import { choropleth } from './bg/choropleth';
import { companies } from './bg/companies';
import { company } from './bg/company';
import { competition } from './bg/competition';
import { contract } from './bg/contract';
import { contractMiniTable } from './bg/contractMiniTable';
import { contracts } from './bg/contracts';
import { entityTables } from './bg/entityTables';
import { filterRail } from './bg/filterRail';
import { flows } from './bg/flows';
import { home } from './bg/home';
import { impressum } from './bg/impressum';
import { listControls } from './bg/listControls';
import { map } from './bg/map';
import { methodology } from './bg/methodology';
import { network } from './bg/network';
import { pagination } from './bg/pagination';
import { privacy } from './bg/privacy';
import { riskIndicators } from './bg/riskIndicators';
import { sankey } from './bg/sankey';
import { searchPage } from './bg/searchPage';
import { singleOffer } from './bg/singleOffer';
import { smartSearch } from './bg/smartSearch';
import { trends } from './bg/trends';
import { ui } from './bg/ui';

export const bg = {
  lang: {
    bg: 'Български',
    en: 'English',
    group: 'Език',
    switchTo: 'Превключи на {lang}',
  },
  brand: {
    aria: 'СИГМА — начална страница',
    title: 'Система за интегриран граждански мониторинг и анализ на обществените поръчки',
    sub: 'Платформа за прозрачност на обществените поръчки',
  },
  nav: {
    aria: 'Главна навигация',
    drawerLabel: 'Навигация',
    close: 'Затвори менюто',
    home: 'Начало',
    authorities: 'Институции',
    companies: 'Компании',
    contracts: 'Договори',
    flows: 'Потоци',
    network: 'Мрежа',
    trends: 'Тренд',
    map: 'Карта',
    competition: 'Конкуренция',
    analytics: 'Анализи',
    methodology: 'Методология',
  },
  search: {
    toggle: 'Търсене',
    menu: 'Меню',
    placeholder: 'Институция, компания или договор',
    submit: 'Намери',
    close: 'Затвори търсенето',
  },
  a11y: {
    skip: 'Към съдържанието',
  },
  footer: {
    methodology: 'Методология',
    accessibility: 'Достъпност',
    privacy: 'Поверителност',
    impressum: 'Импресум',
    openSource: 'Отворен код',
    dataSourceLicense: 'Източник (CC-BY 4.0): АОП / ЦАИС ЕОП — отворени данни (storage.eop.bg)',
    lastContract: 'последен договор {date}',
    dataRefreshed: 'данни обновени {date}',
  },
  og: {
    imageAlt: 'СИГМА — платформа за прозрачност на обществените поръчки',
    siteDescription: 'Платформа за прозрачност на обществените поръчки в България',
  },
  error: {
    kicker404: 'Грешка 404',
    kicker: 'Грешка',
    title404: 'Страницата не е намерена',
    title: 'Възникна грешка',
    lede404:
      'Такъв запис няма или адресът се е променил. Започни от търсенето или от някой от списъците.',
    lede: 'Нещо се обърка при зареждането. Опитай пак или се върни в началото.',
    docTitle404: 'Страницата не е намерена — СИГМА',
    docTitle: 'Грешка — СИГМА',
  },
  // Per-page and per-component namespaces (./bg/*).
  accessibility,
  analytics,
  authorities,
  authority,
  breadcrumbs,
  choropleth,
  companies,
  company,
  competition,
  contract,
  contractMiniTable,
  contracts,
  entityTables,
  filterRail,
  flows,
  home,
  impressum,
  listControls,
  map,
  methodology,
  network,
  pagination,
  privacy,
  riskIndicators,
  sankey,
  searchPage,
  singleOffer,
  smartSearch,
  trends,
  ui,
} as const;
