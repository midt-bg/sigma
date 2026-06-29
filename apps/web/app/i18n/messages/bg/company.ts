export const company = {
  metaTitle: '{name} — СИГМА',
  metaDescription: 'Профил на {name} в обществените поръчки {range}.',
  fallbackName: 'Компания',

  breadcrumbHome: 'Начало',
  breadcrumbCompanies: 'Компании',

  kindConsortium: 'Обединение',
  kindCompany: 'Компания',
  noEik: 'без ЕИК',
  eik: 'ЕИК',

  ledeConsortium:
    'Колко публични средства е спечелило това обединение по обществени поръчки за периода {range} г.',
  ledeCompany:
    'Колко публични средства е спечелила тази компания по обществени поръчки за периода {range} г.',

  factsLabel: 'Ключови показатели',
  factTotalWon: 'Общо спечелено',
  factMainSector: 'Основен сектор',
  factSectorShare: '{pct} от стойността',
  factContracts: 'Брой договори',
  factPayingAuthorities: 'Институции платци',
  factPeriod: 'Период',
  factEuShare: 'Дял с финансиране от ЕС',
  factAvgBids: 'Средно оферти на търг',
  factEntityType: 'Вид субект',
  entityConsortium: 'обединение',
  entityCompany: 'дружество',
  entitySubConsortium: '(ДЗЗД / консорциум)',
  entitySubNoEik: 'без ЕИК в източника',
  factSeat: 'Седалище',
  factUnverifiedValue: 'Непотвърдена стойност',
  contracts_one: 'договор',
  contracts_many: 'договора',
  unverifiedValueSub: 'изключени от сумите — данните се проверяват',

  trendTitle: 'Тренд',
  trendHint:
    'Спечеленото от {name} във времето. Договорите без валидна дата не влизат в графиката.',
  trendCaption: 'Разходи по години',
  trendEmpty: 'Няма достатъчно данни за времева графика.',

  networkTitle: 'Мрежа',
  networkHint:
    'Най-силните преки връзки около {name} и по една следваща връзка за всеки възложител.',
  networkFullLink: 'Виж пълната мрежа →',
  networkCaption: 'Връзки в графа',
  networkEmpty: 'Няма достатъчно връзки за граф.',

  participantsTitle: 'Участници в обединението ({count})',
  participantsDescriptionTitle: 'Описание на обединението',
  participantsHint:
    'Имената са от описанието на договора в АОП. Сумите се водят на ниво обединение; отделни профили на участниците ще се появят след свързване с Търговския регистър.',
  participantsDescriptionHint:
    'Източникът дава свободен текст вместо подреден списък с участници. Запазваме описанието както е в обявата.',

  fromTitle: 'Откъде печели',
  fromHint: 'Институции, подредени по сумата, платена на {name}.',
  fromCaption: 'Институции платци, подредени по сумата, платена на компанията',
  colRank: '#',
  colAuthority: 'Институция',
  colPaidToCompany: 'Платено на компанията',
  colContracts: 'Договори',
  colShareOfWon: 'Дял от спечеленото',
  labelPaid: 'Платено',
  labelShare: 'Дял',
  moreAuthorities: '… още {count} институции — виж всички договори →',

  howWinTitle: 'Как печели',
  howWinHint: 'Видът процедури, по които компанията е печелила договорите.',

  bidsTitle: 'Брой оферти на спечелените търгове',
  bidsHint:
    'Колко оферти е имало на спечелените от компанията търгове (там, където данните го показват).',
  bidsOne: '1 оферта',
  bidsTwo: '2 оферти',
  bidsThree: '3 оферти',
  bidsFourPlus: '4 и повече оферти',
  bidsNoData: 'няма данни',
  tenders: 'търга',
  bidsCaption: 'Брой оферти на спечелените търгове',
  bidsColBids: 'Брой оферти',
  bidsColTenders: 'Брой търгове',

  contractsTitle: 'Договори',
  contractsSortLabel: 'Подреждане на договорите',
  contractsHint:
    '{shown} от {total} {word} — превключи между най-новите и най-големите по стойност.',
  tabNewest: 'Най-нови',
  tabLargest: 'Най-големи по стойност',
  viewAllCsv: 'Виж всички / филтрирай / свали като CSV →',
} as const;
