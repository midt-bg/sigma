export const methodology = {
  metaTitle: 'Methodology and glossary — СИГМА',
  metaDescription:
    'Where the figures come from, how they are assembled, and what we deliberately do not show.',

  breadcrumbHome: 'Home',
  breadcrumbCurrent: 'Methodology',

  kicker: 'How we read the data',
  title: 'Methodology and glossary',
  lede: 'СИГМА brings together public data from the Public Procurement Register (АОП / ЦАИС ЕОП). On this page we describe where the figures come from, how they are assembled, what we present as a neutral fact, and what we deliberately do not show in this first version.',

  edition: 'Edition 1',
  editionLastContract: ' · latest contract {date}',
  editionRefreshed: ' · data refreshed {date}',

  tocAria: 'Page contents',
  tocTitle: 'Contents',

  toc: {
    what: 'What СИГМА shows',
    source: 'Data source and coverage',
    unit: 'The core unit: the contract',
    principles: 'Principles',
    glossary: 'Glossary of terms',
    money: 'Currency, rounding, periods',
    identity: 'Names, ЕИК, УНП',
    gaps: 'Known gaps in the fields',
    export: 'Downloading and data access',
    contact: 'Corrections and feedback',
  },

  period: '{first} — {end} ({end} partial)',

  gaps: {
    instField: 'Institution: name and ID',
    instSrc: 'Notice / OCDS parties',
    companyField: 'Company: name and ЕИК',
    companySrc: 'Award decision + contract',
    valueField: 'Value (in euro)',
    valueSrc: 'Contract',
    unpField: 'УНП · date · CPV code',
    unpSrc: 'Case file / notice',
    sectorField: 'Sector (CPV division)',
    sectorSrc: 'CPV division (unambiguous)',
    objectField: 'Object (supplies/services/works)',
    objectSrc: 'Notice',
    euFundField: 'EU funding (yes/no)',
    euFundSrc: 'Notice',
    instTypeField: 'Type of institution',
    instTypeSrc: 'Type of contracting authority (PPA); the grouping is approximate',
    bidsField: 'Number of bids',
    bidsSrc: 'Award decision, protocol',
    euProgField: 'EU programme (name)',
    euProgSrc: 'Notice',
    durationField: 'Term and performance dates',
    durationSrc: 'Notice',
    currentValField: 'Current value (with amendments)',
    currentValSrc: 'Supplementary agreements',
    lotLinkField: 'Contract ↔ lot link',
    lotLinkSrc: 'Notice / OCDS',
    seatField: 'Registered seat (city/region)',
    seatSrc: 'OCDS parties / address',
    secondaryCpvField: 'Secondary (additional) CPV',
    bidValuesField: 'Values of individual bids',
    badgeYes: 'yes',
    badgeNo: 'no',
    badgeOnAnnex: 'on amendment',
    badgeWhenAvailable: 'when available',
    dash: '—',
  },

  what: {
    heading: '1. What СИГМА shows',
    intro1: 'СИГМА — ',
    introEm: 'System for Integrated Civic Monitoring and Analysis',
    intro2: ' — is a public tool for examining public procurement in Bulgaria. It shows ',
    introStrong: 'three things',
    intro3: ' and the connections between them:',
    instStrong: 'Institutions',
    instText: ' — the contracting authorities. Who spends how much, and on what.',
    companyStrong: 'Companies',
    companyText:
      ' — the contractors, keyed by ЕИК. How much each has won, from whom, and in what sector.',
    contractStrong: 'Contracts',
    contractText:
      ' — the core unit. Every aggregate reduces to the specific contracts that make it up.',
    readOnly:
      'СИГМА is entirely read-only: it does not add new data, does not assess procedures, and does not flag companies as risky.',
    calloutTitle: 'What this version is suited for',
    calloutBody:
      'Journalists, researchers, municipal councillors, NGOs, and citizens who want to start from the name of an institution or company and arrive at the specific contracts. It does not replace legal or audit analysis.',
  },

  source: {
    heading: '2. Data source and coverage',
    primaryDt: 'Primary source',
    primaryDd: 'Public Procurement Register (АОП / ЦАИС ЕОП) — open data from storage.eop.bg.',
    namesDt: 'Institution names',
    namesDd: 'Institution names are canonicalised and normalised.',
    periodDt: 'Period covered',
    periodDd: '{period}. Contracts from the current year enter with a delay of a few weeks.',
    sectorsDt: 'Sectors covered',
    sectorsDdStrong: 'All sectors.',
    sectorsDd:
      ' The sector is determined unambiguously from the CPV code (division = the first two digits); all {sectors} CPV divisions are present.',
    recordsDt: 'Number of records',
    recordsDd:
      '{contracts} contracts and lots, {authorities} institutions, {bidders} companies, totalling ',
    recordsAsOf: ' as of {date}',
    recordsRefreshed: ' The data was refreshed on {date}.',
    excludedDtBefore: 'What is ',
    excludedDtEm: 'not',
    excludedDtAfter: ' included',
    excludedDd:
      'Procurements below the publication threshold appear here only if the contracting authority published a contract. Defence and security procurements handled under a special regime are not included.',
    suspectDt: 'Unconfirmed values',
    suspectDd:
      '{suspect} contracts with an evidently unreliable value (e.g. an amendment ≥100× or an error) remain in the record count, but their value is excluded from the totals and flagged as "value of unconfirmed reliability".',
  },

  unit: {
    heading: '3. The core unit: the contract',
    bodyStrong: 'signed contract',
    body1: 'A single ',
    body2:
      ' (or a single lot of a multi-lot procedure) is the smallest unit СИГМА shows. Everything else — an institution’s total, a company’s volume, the flow between the two — is a sum or count over a list of such contracts.',
    calloutTitle: 'Why we do not show individual bidders’ offers',
    calloutBody1: 'The register publishes the ',
    calloutBodyStrong1: 'number',
    calloutBody2: ' of bids received, but the ',
    calloutBodyStrong2: 'values of the individual bids',
    calloutBody3:
      ' (other than the winner’s) are not in the machine-readable record. This field does not exist in any open source and is not present in the platform.',
  },

  principles: {
    heading: '4. Principles',
    p1Strong: 'Behind every figure stand its contracts.',
    p1Text:
      ' Every total has a "see the contracts" link. If we cannot show them, we do not show the figure either.',
    p2Strong: 'Standardised names, original identifiers.',
    p2Text: ' Names are brought into canonical form; ЕИК and УНП are kept verbatim.',
    p3Strong: 'СИГМА does not interpret — it displays.',
    p3Text:
      ' Rankings, shares, and ratios are neutral numbers; the reader draws their own conclusion.',
    p4Strong: 'A shareable address for every view.',
    p4Text: ' Filters are recorded in the address (URL) — every combination has a permanent link.',
    p5Strong: 'We do not keep the user’s actions.',
    p5Text: ' No registration, no tracking.',
    p6Strong: 'An empty field is better than an invented value.',
    p6Text: ' When the source provides no value, we show "—".',
  },

  glossary: {
    heading: '5. Glossary of terms',
    authorityTerm: 'Institution (contracting authority)',
    authorityDef:
      'A public organisation that runs the procurement. The different spellings of its name in АОП are merged into a single canonical record.',
    authoritySrc: '→ authorities.name',
    companyTerm: 'Company (contractor)',
    companyDef:
      'A legal entity or consortium that won an award. The unique key is the ЕИК; names without a valid ЕИК remain separate until merged manually.',
    companySrc: '→ bidders.bulstat / bidders.name',
    lotTerm: 'Lot',
    lotDef:
      'A single case file may be split into several lots, each with a separate contractor. In СИГМА each lot is a standalone record, shown under the shared case file.',
    lotSrc: '→ lots',
    unpTerm: 'УНП',
    unpDef1: 'The unique case-file number in АОП — e.g. ',
    unpExample: '00044-2023-0018',
    unpDef2: '. We keep it exactly as published; it can be searched directly.',
    unpSrc: '→ tenders.source_id',
    sectorTerm: 'Sector',
    sectorDef:
      'An unambiguous group derived from the CPV code: the division (the first two digits) — e.g. 45 → construction, 33 → medical and pharmaceutical. It is not a guess but a label from the CPV 2008 catalogue.',
    sectorSrc: '→ substr(cpv_code, 1, 2)',
    consortiumTerm: 'Consortium / ДЗЗД',
    consortiumDef:
      'Several firms with a joint bid register as a single new entity. СИГМА shows the consortium as a separate contractor with a neutral label, and the amount is attributed to it — the allocation among members is not part of this version.',
    consortiumSrc: '→ bidders.kind',
    flowTerm: 'Flow',
    flowDef:
      'The sum of all contracts between one institution and one company over the selected period — a computed quantity that always has its contracts behind it.',
    flowSrc: '→ GROUP BY authority, bidder',
    networkTerm: 'Connection network',
    networkDef:
      'The graph shows only the direct connections around a selected authority or company and their next-level connections (a focused neighbourhood), not the entire graph. A single line is the sum of the contracts between two entities.',
    networkSrc: '→ flow_pairs',
    signedTerm: 'Signing date',
    signedDef:
      'The day the contract was signed. The trend chart groups spending by this date; contracts without a valid signing date are not included in it and are reported separately as coverage.',
    signedSrc: '→ contracts.signed_at',
    regionTerm: 'Region (NUTS3)',
    regionDef:
      "The authority's region is derived from its address (NUTS code from the register), so it is known only for some authorities. On the spending map, authorities with no specified region are shown separately and are not assigned to any region.",
    regionSrc: '→ authorities.region',
    singleBidTerm: 'Single-bid contract share',
    singleBidDef1: "The share of an authority's contracts that received ",
    singleBidStrong: 'only one bid',
    singleBidDef2:
      ' (of those with a known number of bids). A neutral indicator of weak competition, not an assessment of the procedure, and it does not flag the authority or the contractor as offenders.',
    singleBidSrc: '→ bids_received = 1',
    hhiTerm: 'Supplier concentration (HHI)',
    hhiDef:
      "The Herfindahl-Hirschman Index over the distribution of one authority's money among its contractors: close to 0 means spread across many companies, while 1 means everything goes to one. Values above 0.25 are flagged as high concentration (a DOJ/FTC benchmark). A computed measure backed by the specific contracts.",
    hhiSrc: '→ sum of the squares of the suppliers’ shares',
  },

  money: {
    heading: '6. Currency, rounding, periods',
    p1a: 'A contract passes through three values that are often confused: ',
    p1Strong1: 'estimated',
    p1b: ' (announced in the notice), ',
    p1Strong2: 'at signing',
    p1c: ' (the price of the winning bid) and ',
    p1Strong3: 'current',
    p1d: ' (after all amendments). Rankings use a cleaned, comparable value: the current one when an amendment lawfully increased it, otherwise the value at signing.',
    p2a: 'All amounts are shown in ',
    p2Strong1: 'euro',
    p2b: '. Historical leva are converted at the fixed rate ',
    p2Strong2: '1 EUR = 1.95583 BGN',
    p2c: ' (currency board since 1997; fixed rate to the euro since 1999); foreign currencies at the rate on the signing date. We round to whole euro (below €1,000), thousands, millions, or billions.',
    p3: 'Contracts in a foreign currency for which no rate on the signing date was found are kept as records but excluded from the euro totals.',
  },

  identity: {
    heading: '7. Names, ЕИК, УНП',
    intro:
      'The same entity is often spelled differently across thousands of notices. This is the most sensitive part of the data:',
    instStrong: 'Institutions',
    instText: ' are merged by legal entity (ЕИК), not by name.',
    companyStrong: 'Companies',
    companyText:
      ' are keyed by a normalised ЕИК; 9- and 13-digit codes are not merged automatically. Contractors without a valid ЕИК carry an "unconfirmed ЕИК" note and may fragment across name variants.',
    namesStrong: 'Names',
    namesText:
      ' are shown as they appear in the source, with the original punctuation preserved — exactly as published.',
    unpStrong: 'УНП',
    unpText:
      ' is kept unedited and can be searched directly. Search is case- and accent-insensitive and handles Cyrillic and Latin alike within each script.',
  },

  gapsSection: {
    heading: '8. Known gaps in the fields',
    hint: 'Which fields are available, which are partial, and which are missing. Partial fields are shown only for the records that have data — never as an invented value.',
    caption: 'Availability of fields against the source in AOP',
    colField: 'Field',
    colSource: 'Source in АОП',
    colReady: 'Ready',
    footStrong1: 'Place of performance',
    footMid1: ', ',
    footStrong2: 'owners and related parties',
    footMid2: ' and ',
    footStrong3: 'risk signals',
    footText:
      ' are under development for a future version — they require a full merge with additional sources and a separate analytical layer.',
  },

  exportSection: {
    heading: '9. Downloading and data access',
    intro: 'Every list can be downloaded as CSV — exactly what you see, with the applied filters:',
    listAuthorities: 'Institutions',
    listCompanies: 'Companies',
    listContracts: 'Contracts',
    listSep1: ' · ',
    listSep2: ' · ',
    listSuffix: ' → the "Download CSV" button in the filters.',
    jsonItem:
      'A single contract can also be downloaded as JSON from its page — the full record, unedited.',
    noApi: 'For now we do not offer a public real-time API.',
  },

  contact: {
    heading: '10. Corrections and feedback',
    p1: 'We fix errors manually upon report — duplicate records for an institution/company (send both ЕИК / links) or an amount that does not match the original document (send the УНП).',
    p2a: 'СИГМА does ',
    p2Em: 'not',
    p2b: ' remove records at the request of contractors or contracting authorities. All data comes from public sources and remains public.',
  },
};
