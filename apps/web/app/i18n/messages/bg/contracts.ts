export const contracts = {
  metaTitle: 'Договори — СИГМА',
  metaDescription:
    'Всеки сключен договор по обществена поръчка. Филтрите са в адреса, има и сваляне в CSV.',

  bucketLt100k: 'Под 100 хил. €',
  bucket100k1m: '100 хил. – 1 млн. €',
  bucket1m10m: '1 – 10 млн. €',
  bucket10m100m: '10 – 100 млн. €',
  bucketGt100m: 'Над 100 млн. €',

  filterProcedure: 'Процедура',
  filterYear: 'Година',
  filterValue: 'Стойност (в евро)',
  filterEu: 'Финансиране от ЕС',
  euOnly: 'Само с финансиране от ЕС',
  nationalOnly: 'Само без финансиране от ЕС',

  breadcrumbHome: 'Начало',
  breadcrumbContracts: 'Договори',

  kicker_one: '{count} договор',
  kicker_many: '{count} договора',
  title: 'Договори',
  lede: 'Всеки сключен договор по обществена поръчка. Всяко обобщение другаде в платформата — обща сума за институция, за компания или поток между двете — се свежда точно до този списък. Филтрите остават в адреса.',

  sortNew: 'нови',
  sortOld: 'стари',
  sortValueDesc: 'стойност ↓',
  sortValueAsc: 'стойност ↑',

  foundPre: 'Намерени ',
  foundContracts_one: 'договор',
  foundContracts_many: 'договора',
  suspectCount: '{count} с непотвърдена стойност',

  filteredBy: 'Филтрирано по ',
  filterAuthority: 'институция',
  filterBidder: 'компания',
  filterAnd: ' и ',
  clear: 'изчисти',

  noResults: 'Няма резултати за избраните филтри. ',
  clearFilters: 'Изчисти филтрите',

  thRank: '#',
  thContract: 'Договор',
  thParties: 'Възложител · Изпълнител',
  thProcedureDate: 'Процедура · Дата',
  thValue: 'Стойност (€)',
  tableCaption: 'Договори по обществени поръчки',
  euFunded: 'ЕС',
  unp: 'УНП {unp}',
  consortiumSuffix: ' · обединение',
  roleAuthority: 'възложител',
  roleBidder: 'изпълнител',
  valueChecking: 'данните се проверяват',

  calloutTitle: 'Какво е „договор“ в СИГМА',
  calloutBody:
    'Един възложен договор по обществена поръчка, на ниво обособена позиция (лот). Стойностите са в евро — изчистена, съпоставима стойност на договора.',
} as const;
