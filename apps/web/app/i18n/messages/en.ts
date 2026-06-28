import type { Messages } from './types';
import { accessibility } from './en/accessibility';
import { analytics } from './en/analytics';
import { authorities } from './en/authorities';
import { authority } from './en/authority';
import { breadcrumbs } from './en/breadcrumbs';
import { choropleth } from './en/choropleth';
import { companies } from './en/companies';
import { company } from './en/company';
import { competition } from './en/competition';
import { contract } from './en/contract';
import { contractMiniTable } from './en/contractMiniTable';
import { contracts } from './en/contracts';
import { entityTables } from './en/entityTables';
import { filterRail } from './en/filterRail';
import { flows } from './en/flows';
import { home } from './en/home';
import { impressum } from './en/impressum';
import { listControls } from './en/listControls';
import { map } from './en/map';
import { methodology } from './en/methodology';
import { network } from './en/network';
import { pagination } from './en/pagination';
import { privacy } from './en/privacy';
import { riskIndicators } from './en/riskIndicators';
import { sankey } from './en/sankey';
import { searchPage } from './en/searchPage';
import { singleOffer } from './en/singleOffer';
import { smartSearch } from './en/smartSearch';
import { trends } from './en/trends';
import { ui } from './en/ui';

// English message catalog. Typed as `Messages` (the widened shape of the Bulgarian catalog) so it must
// mirror bg.ts's key structure exactly — a missing or extra key is a compile error. Chrome keys inline;
// per-page/per-component strings composed from ./en/<namespace>.ts.

export const en: Messages = {
  lang: {
    bg: 'Български',
    en: 'English',
    group: 'Language',
    switchTo: 'Switch to {lang}',
  },
  brand: {
    aria: 'СИГМА — home',
    title: 'System for Integrated Civic Monitoring and Analysis of public procurement',
    sub: 'Public procurement transparency platform',
  },
  nav: {
    aria: 'Main navigation',
    drawerLabel: 'Navigation',
    close: 'Close menu',
    home: 'Home',
    authorities: 'Authorities',
    companies: 'Companies',
    contracts: 'Contracts',
    flows: 'Flows',
    network: 'Network',
    trends: 'Trend',
    map: 'Map',
    competition: 'Competition',
    analytics: 'Analytics',
    methodology: 'Methodology',
  },
  search: {
    toggle: 'Search',
    menu: 'Menu',
    placeholder: 'Authority, company or contract',
    submit: 'Search',
    close: 'Close search',
  },
  a11y: {
    skip: 'Skip to content',
  },
  footer: {
    methodology: 'Methodology',
    accessibility: 'Accessibility',
    privacy: 'Privacy',
    impressum: 'Imprint',
    openSource: 'Open source',
    dataSourceLicense: 'Source (CC-BY 4.0): AOP / CAIS EOP — open data (storage.eop.bg)',
    lastContract: 'latest contract {date}',
    dataRefreshed: 'data refreshed {date}',
  },
  og: {
    imageAlt: 'СИГМА — public procurement transparency platform',
    siteDescription: 'Public procurement transparency platform in Bulgaria',
  },
  error: {
    kicker404: 'Error 404',
    kicker: 'Error',
    title404: 'Page not found',
    title: 'Something went wrong',
    lede404: 'No such record, or the address has changed. Start from search or one of the lists.',
    lede: 'Something went wrong while loading. Try again or return to the start.',
    docTitle404: 'Page not found — СИГМА',
    docTitle: 'Error — СИГМА',
  },
  // Per-page and per-component namespaces (./en/*).
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
};
