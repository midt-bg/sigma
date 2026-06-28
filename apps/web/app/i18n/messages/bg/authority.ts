export const authority = {
  metaTitle: '{name} — СИГМА',
  metaDescription: 'Обществени поръчки на {name}, {range}.',
  fallbackName: 'Институция',

  breadcrumbHome: 'Начало',
  breadcrumbAuthorities: 'Институции',

  kind: 'Институция',

  lede: 'Колко публични средства е похарчила институцията за обществени поръчки през {range} г. Зад всяко число по-долу стоят конкретните договори, които го формират.',

  factsLabel: 'Ключови показатели',
  factTotalValue: 'Обща стойност',
  factContracts: 'Брой договори',
  factPeriod: 'Период',
  factDistinctSuppliers: 'Различни изпълнители',
  factEuShare: 'Дял с финансиране от ЕС',
  factEuShareSub: 'от общия обем',
  factAvgBids: 'Средно оферти на търг',
  factSeat: 'Седалище',
  noData: 'няма данни',
  factTopSectors: 'Топ сектори',
  factUnverifiedValue: 'Непотвърдена стойност',
  unverifiedValueSub: 'изключени от сумите',
  contracts_one: 'договор',
  contracts_many: 'договора',

  trendTitle: 'Тренд',
  trendHint: 'Разходите на {name} във времето. Договорите без валидна дата не влизат в графиката.',
  trendCaption: 'Разходи по години',
  trendEmpty: 'Няма достатъчно данни за времева графика.',

  singleOfferTitle: 'Една оферта',
  singleOfferHint: 'Дял на договорите с известен брой оферти, възложени само с една оферта.',
  singleOfferScope: 'на поръчките',
  singleOfferCaptionSuffix: 'по стойност',
  singleOfferCompareLink: 'Виж сравнението с други възложители →',
  singleOfferEmpty: 'Няма договори с известен брой оферти.',

  networkTitle: 'Мрежа',
  networkHint:
    'Най-силните преки връзки около институцията и по една следваща връзка за всеки контрагент.',
  networkFullLink: 'Виж пълната мрежа →',
  networkCaption: 'Връзки в графа',
  networkEmpty: 'Няма достатъчно връзки за граф.',

  topContractorsTitle: 'Топ изпълнители',
  topContractorsHint:
    'Подредени по общата сума, спечелена от {name}. Колоната „Дял" показва каква част от парите отива при всеки изпълнител.',
  colRank: '#',
  colCompany: 'Компания',
  colWon: 'Спечелено',
  colContracts: 'Договори',
  colShareOfTotal: 'Дял от общата сума',
  labelShare: 'Дял',
  chipConsortium: 'обединение',
  moreContractors: '… още {count} изпълнители — виж всички договори →',

  whatTitle: 'Какво купува',
  whatHint: 'CPV категориите, подредени по обем.',
  whatCaption: 'Какво купува {name} — по CPV категория',
  whatColSector: 'Сектор (CPV)',
  whatColValueShare: 'Стойност и дял',

  howTitle: 'Как купува',
  howHint: 'Разпределение на договорите по вид процедура.',

  allTitle: 'Договори',
  contractsSortLabel: 'Подреждане на договорите',
  allHint: '{count} {word}, {range} — превключи между най-новите и най-големите по стойност.',
  tabNewest: 'Най-нови',
  tabLargest: 'Най-големи по стойност',
  viewAllCsv: 'Виж всички / филтрирай / свали като CSV →',
} as const;
